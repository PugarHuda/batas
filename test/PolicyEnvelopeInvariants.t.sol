// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { FeeFlatIn } from "@1inch/swap-vm/src/instructions/FeeFlat.sol";
import { CoreInvariants } from "@1inch/swap-vm/test/invariants/CoreInvariants.t.sol";

import { BatasRouter } from "../src/BatasRouter.sol";
import { PolicyEnvelope } from "../src/PolicyEnvelope.sol";

/// @notice Runs PolicyEnvelope against SwapVM's own invariant harness.
/// @dev The claim being tested is narrow and worth stating precisely: while the mandate is *not*
///   binding, wrapping a strategy in it must leave the strategy's economics untouched. Every core
///   invariant SwapVM defines — symmetry, monotonicity, quote/swap consistency, rounding in the
///   maker's favour, balance sufficiency — has to survive the extra frame.
///
///   A binding mandate reverting is not an invariant violation; it is the feature. So the limits
///   here are set far outside the probe amounts on purpose.
contract PolicyEnvelopeInvariantsTest is Test, CoreInvariants {
    Aqua internal aqua;
    BatasRouter internal swapVM;
    TokenMock internal tokenA;
    TokenMock internal tokenB;

    address internal maker = makeAddr("maker");

    uint256 internal constant RESERVE_A = 10_000e18;
    uint256 internal constant RESERVE_B = 20_000e18;

    // Deliberately unreachable by the probe amounts below.
    uint128 internal constant MAX_AMOUNT_IN = type(uint128).max;
    uint128 internal constant MIN_RATE = 1;

    ISwapVM.Order internal order;

    function setUp() public {
        aqua = new Aqua();
        swapVM = new BatasRouter(address(aqua), address(0), address(this), "Batas", "1.0.0");

        tokenA = new TokenMock("A", "A");
        tokenB = new TokenMock("B", "B");
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);

        tokenA.mint(maker, RESERVE_A);
        tokenB.mint(maker, RESERVE_B);
        vm.startPrank(maker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        tokenA.approve(address(swapVM), type(uint256).max);
        tokenB.approve(address(swapVM), type(uint256).max);

        bytes memory program = bytes.concat(
            PolicyEnvelope.build(MAX_AMOUNT_IN, MIN_RATE), FeeFlatIn.build(0.003e7), XYCSwap.build()
        );
        order = _order(program);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE_A;
        amounts[1] = RESERVE_B;

        vm.prank(maker);
        aqua.ship(address(swapVM), abi.encode(order), tokens, amounts);
    }

    function _executeSwap(
        SwapVM vm_,
        ISwapVM.Order memory order_,
        address tokenIn,
        address,
        uint256 amount,
        bytes memory takerData
    ) internal override returns (uint256 amountIn, uint256 amountOut) {
        TokenMock(tokenIn).mint(address(this), amount * 10);
        (amountIn, amountOut,) = vm_.swap(order_, amount, takerData);
    }

    /// @notice A non-binding mandate must leave every core invariant intact.
    function test_EnvelopePreservesCoreInvariants() public {
        InvariantConfig memory config = _getDefaultConfig();

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 1e18;
        amounts[1] = 10e18;
        amounts[2] = 50e18;
        config.testAmounts = amounts;

        config.exactInTakerData = _takerData(true, "");
        config.exactOutTakerData = _takerData(false, abi.encodePacked(bytes32(type(uint256).max)));

        // A flat maker fee is subadditive by construction, which the harness documents; that is a
        // property of FeeFlatIn, not of the envelope wrapped around it.
        config.skipAdditivity = true;

        assertAllInvariantsWithConfig(swapVM, order, address(tokenA), address(tokenB), config);
    }

    function _order(bytes memory program) internal view returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                tokenA: address(tokenA),
                tokenB: address(tokenB),
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

    function _takerData(bool isExactIn, bytes memory threshold) internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(this),
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: true,
                useTransferFromAndAquaPush: true,
                isAToB: true,
                allowPartialFill: false,
                threshold: threshold,
                to: address(this),
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
