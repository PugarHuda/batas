// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { BatasRouter } from "../src/BatasRouter.sol";
import { Mandate, MandateLib } from "../src/Mandate.sol";

/// @notice End-to-end walkthrough on a live chain: grant a mandate, trade inside it, then watch
///   the same position refuse a trade that breaks it. Real ERC-20 transfers, no mocked settlement.
contract Demo is Script {
    /// @dev Aqua is canonical and identical on every chain it is live on.
    address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;

    /// @dev Defaults point at the Sepolia deployment so the walkthrough runs out of the box, but
    ///   anyone who deploys their own set can point at it without editing this file.
    address internal constant DEFAULT_ROUTER = 0x648a0F330f432452CF53B967fd13305528C320a6;
    address internal constant DEFAULT_TOKEN_A = 0x3b8B1A25502C9f4C84e93A17dCc1720379cEa29B;
    address internal constant DEFAULT_TOKEN_B = 0x6D3987Cbc99723fb7a13D4C6Ce54bA3Ab919fB81;

    uint256 internal constant RESERVE_A = 1_000e18;
    uint256 internal constant RESERVE_B = 2_000e18; // opening rate 2.0

    uint128 internal constant MAX_AMOUNT_IN = 100e18;
    uint128 internal constant MIN_RATE = 1.9e18;
    uint24 internal constant FEE_BPS = 0.003e7; // 0.3%
    /// @dev Default length of the grant, matching the agent. A mandate without one is authority
    ///   that never ends; a mandate whose length nobody can choose is a limit the maker does not
    ///   actually control. Override with BATAS_MANDATE_HOURS.
    uint256 internal constant DEFAULT_HOURS = 2;

    function run() external {
        uint256 pk = vm.envUint("SEPOLIA_PRIVATE_KEY");
        address me = vm.addr(pk);

        address routerAddr = vm.envOr("BATAS_ROUTER", DEFAULT_ROUTER);
        address tokenAAddr = vm.envOr("BATAS_TOKEN_A", DEFAULT_TOKEN_A);
        address tokenBAddr = vm.envOr("BATAS_TOKEN_B", DEFAULT_TOKEN_B);
        require(routerAddr.code.length > 0, "router has no code on this chain");

        BatasRouter router = BatasRouter(payable(routerAddr));
        (address t0, address t1) = tokenAAddr < tokenBAddr ? (tokenAAddr, tokenBAddr) : (tokenBAddr, tokenAAddr);

        // Built through MandateLib rather than instruction by instruction. An inline chain here
        // is how this script silently shipped mandates with no Deadline at all — the terms looked
        // right in the log and the position simply never expired. One encoder, used by the tests
        // and by the agent, is what stops that from being possible.
        //
        // Aqua permanently burns a strategy hash, so the same terms need a fresh salt each run.
        // That is what Salt is for: a no-op whose bytes change the program hash.
        Mandate memory mandate = Mandate({
            maker: me,
            agent: me,
            tokenIn: t0,
            tokenOut: t1,
            maxAmountIn: MAX_AMOUNT_IN,
            minRateE18: MIN_RATE,
            expiry: uint64(block.timestamp + vm.envOr("BATAS_MANDATE_HOURS", DEFAULT_HOURS) * 1 hours),
            feeBps: FEE_BPS,
            salt: uint64(block.timestamp),
            nameRegistry: address(0),
            nameHolder: address(0),
            nameLabel: ""
        });
        bytes memory program = MandateLib.toProgram(mandate);
        ISwapVM.Order memory order = _order(me, t0, t1, program);

        console.log("mandate: max %s in, floor rate %s, 0.3%% fee", MAX_AMOUNT_IN, MIN_RATE);
        console.log("expires at %s (%s hours from now)", mandate.expiry, vm.envOr("BATAS_MANDATE_HOURS", DEFAULT_HOURS));

        vm.startBroadcast(pk);

        TokenMock(t0).mint(me, RESERVE_A + 500e18);
        TokenMock(t1).mint(me, RESERVE_B);
        IERC20(t0).approve(AQUA, type(uint256).max);
        IERC20(t1).approve(AQUA, type(uint256).max);
        IERC20(t0).approve(routerAddr, type(uint256).max);

        address[] memory tokens = new address[](2);
        tokens[0] = t0;
        tokens[1] = t1;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE_A;
        amounts[1] = RESERVE_B;

        bytes32 strategyHash = IAqua(AQUA).ship(routerAddr, abi.encode(order), tokens, amounts);
        console.log("shipped, mandate hash:");
        console.logBytes32(strategyHash);

        // A trade inside the mandate settles. Output goes to a separate address so the transfer
        // is visible on-chain rather than netting out against the maker's own reserve.
        address recipient = address(uint160(uint256(keccak256("batas.demo.recipient"))));
        uint256 beforeOut = IERC20(t1).balanceOf(recipient);
        (uint256 amountIn, uint256 amountOut,) = router.swap(order, 10e18, _takerData(me, recipient));
        console.log("settled: in %s out %s", amountIn, amountOut);
        console.log("recipient received %s of tokenB", IERC20(t1).balanceOf(recipient) - beforeOut);
        console.log("recipient:", recipient);

        vm.stopBroadcast();

        // And the refusal, against the same live position, in the same run.
        //
        // This used to print a `cast call` with an ellipsis in the middle of it — an instruction to
        // go and assemble an abi-encoded Order by hand, which is another way of saying the one
        // behaviour this project exists for was the one thing the demo did not demonstrate. It is
        // read-only and caught: outside the broadcast so no gas is spent, and inside a try/catch
        // because reverting is the result being shown, not a failure of the script.
        console.log("");
        uint256 overCap = uint256(MAX_AMOUNT_IN) + 1e18;
        try router.quote(order, overCap, _takerData(me, me)) returns (uint256, uint256 out, bytes32) {
            console.log("PROBLEM: %s in was quoted %s out, over a cap of %s", overCap, out, MAX_AMOUNT_IN);
        } catch (bytes memory err) {
            // The selector is PolicyEnvelope.MandateAmountInExceeded(uint256,uint256); the two
            // words after it are the amount asked for and the cap that refused it.
            console.log("refused %s in, over the mandate's cap of %s", overCap, MAX_AMOUNT_IN);
            console.log("  revert data:");
            console.logBytes(err);
        }
    }

    function _order(address maker, address t0, address t1, bytes memory program)
        internal
        pure
        returns (ISwapVM.Order memory)
    {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                tokenA: t0,
                tokenB: t1,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    function _takerData(address taker, address to) internal pure returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: true,
                useTransferFromAndAquaPush: true,
                isAToB: true,
                allowPartialFill: false,
                threshold: "",
                to: to,
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }
}
