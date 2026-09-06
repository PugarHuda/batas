// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { BatasApp } from "../src/BatasApp.sol";
import { BatasRouter } from "../src/BatasRouter.sol";
import { IBatasCallback } from "../src/IBatasCallback.sol";
import { Mandate, MandateLib } from "../src/Mandate.sol";

/// @notice Proves the two enforcement surfaces are one system.
/// @dev Batas checks a mandate in two places: inside `BatasApp`, which is an Aqua application, and
///   inside the VM through `PolicyEnvelope`, which the router runs. Two implementations of the
///   same rule would be a liability — the interesting failure is not one of them being wrong, it
///   is the two of them disagreeing, because then the mandate means something different depending
///   on which door a trade came through.
///
///   So both derive from a single `Mandate`: the app reads its fields directly, and
///   `MandateLib.toProgram` compiles the same fields into bytecode for the router. These tests ship
///   identical reserves to both and check trade by trade that they price the same and refuse the
///   same.
contract MandateAgreementTest is Test, IBatasCallback {
    using MandateLib for Mandate;

    Aqua internal aqua;
    BatasApp internal app;
    BatasRouter internal router;
    TokenMock internal tokenA;
    TokenMock internal tokenB;

    address internal maker = makeAddr("maker");
    address internal agent = makeAddr("agent");

    uint256 internal constant RESERVE_IN = 1_000e18;
    uint256 internal constant RESERVE_OUT = 2_000e18;

    function setUp() public {
        aqua = new Aqua();
        app = new BatasApp(IAqua(address(aqua)));
        router = new BatasRouter(address(aqua), address(0), address(this), "Batas", "1.0.0");

        tokenA = new TokenMock("A", "A");
        tokenB = new TokenMock("B", "B");
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);

        // Enough for two independent positions holding the same reserves.
        tokenA.mint(maker, RESERVE_IN * 2);
        tokenB.mint(maker, RESERVE_OUT * 2);
        vm.startPrank(maker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        tokenA.mint(address(this), 10_000e18);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
    }

    function _mandate(uint128 maxAmountIn, uint128 minRateE18) internal view returns (Mandate memory m) {
        m = Mandate({
            maker: maker,
            agent: agent,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            maxAmountIn: maxAmountIn,
            minRateE18: minRateE18,
            expiry: uint64(block.timestamp + 2 hours),
            feeBps: 0.003e7,
            salt: 1
        });
    }

    /// @dev Ships the same reserves twice: once to the app under the encoded mandate, once to the
    ///   router under the encoded order whose program was compiled from that mandate.
    function _shipBoth(Mandate memory m) internal returns (ISwapVM.Order memory order) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE_IN;
        amounts[1] = RESERVE_OUT;

        vm.prank(maker);
        aqua.ship(address(app), m.encode(), tokens, amounts);

        order = _order(m.toProgram());
        vm.prank(maker);
        aqua.ship(address(router), abi.encode(order), tokens, amounts);
    }

    function batasSwapCallback(address tokenIn_, address, uint256 amountIn, uint256, address maker_, bytes32 h, bytes calldata)
        external
    {
        TokenMock(tokenIn_).mint(address(this), amountIn);
        aqua.push(maker_, address(app), h, tokenIn_, amountIn);
    }

    /// @notice Same mandate, same reserves, same trade: both surfaces must return the same output.
    function test_BothSurfacesPriceIdentically() public {
        Mandate memory m = _mandate(500e18, 1e18);
        ISwapVM.Order memory order = _shipBoth(m);

        uint256[3] memory sizes = [uint256(1e18), 25e18, 200e18];
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 fromApp = app.quote(m, sizes[i]);
            (, uint256 fromVm,) = router.quote(order, sizes[i], _takerData());
            assertEq(fromApp, fromVm, "app and VM must price a mandate identically");
            assertGt(fromApp, 0, "and actually price it");
        }
    }

    /// @notice A trade over the cap must be refused by both, not just whichever one it reached.
    function test_BothSurfacesRefuseOverCap() public {
        Mandate memory m = _mandate(100e18, 1e18);
        ISwapVM.Order memory order = _shipBoth(m);
        uint256 tooBig = 150e18;

        vm.expectRevert();
        app.quote(m, tooBig);

        bytes memory takerData = _takerData();
        vm.expectRevert();
        router.swap(order, tooBig, takerData);
    }

    /// @notice And a price under the floor is refused by both.
    function test_BothSurfacesRefuseBelowFloor() public {
        // The pool opens at 2.0; a 1.99 floor is broken by any size worth trading.
        Mandate memory m = _mandate(500e18, 1.99e18);
        ISwapVM.Order memory order = _shipBoth(m);

        vm.expectRevert();
        app.quote(m, 50e18);

        bytes memory takerData = _takerData();
        vm.expectRevert();
        router.swap(order, 50e18, takerData);
    }

    /// @notice Expiry too, though each expresses it in its own vocabulary: the app raises
    ///   MandateExpired, the compiled program reaches SwapVM's Deadline instruction. Different
    ///   error, same refusal.
    function test_BothSurfacesRefuseAfterExpiry() public {
        Mandate memory m = _mandate(500e18, 1e18);
        ISwapVM.Order memory order = _shipBoth(m);

        vm.warp(uint256(m.expiry) + 1);

        vm.expectRevert();
        app.quote(m, 10e18);

        bytes memory takerData = _takerData();
        vm.expectRevert();
        router.swap(order, 10e18, takerData);
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

    function _takerData() internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(this),
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: true,
                useTransferFromAndAquaPush: true,
                isAToB: true,
                allowPartialFill: false,
                threshold: "",
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
