// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { FeeFlatIn } from "@1inch/swap-vm/src/instructions/FeeFlat.sol";
import { Deadline } from "@1inch/swap-vm/src/instructions/Controls.sol";

import { AmanatRouter } from "../src/AmanatRouter.sol";
import { PolicyEnvelope } from "../src/PolicyEnvelope.sol";

/// @dev Aqua-backed mode: the maker ships liquidity to the router and the encoded order is the
///   Aqua strategy, so no signature is involved at all. Balances come from Aqua rather than from
///   a balance instruction, which is why AquaOpcodes carries none.
contract PolicyEnvelopeTest is Test {
    Aqua internal aqua;
    AmanatRouter internal swapVM;
    TokenMock internal tokenA;
    TokenMock internal tokenB;

    address internal maker = makeAddr("maker");

    uint256 internal constant RESERVE_A = 1_000e18;
    uint256 internal constant RESERVE_B = 2_000e18; // opening rate 2.0

    uint24 internal constant BPS = 1e7;

    function setUp() public {
        aqua = new Aqua();
        swapVM = new AmanatRouter(address(aqua), address(0), address(this), "Amanat", "1.0.0");

        tokenA = new TokenMock("A", "A");
        tokenB = new TokenMock("B", "B");
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);

        tokenA.mint(maker, RESERVE_A);
        tokenB.mint(maker, RESERVE_B);
        vm.startPrank(maker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        tokenA.mint(address(this), 10_000e18);
        tokenA.approve(address(swapVM), type(uint256).max);
        tokenB.approve(address(swapVM), type(uint256).max);
    }

    /// @dev PolicyEnvelope first, so everything after it runs inside the wrapper.
    function _program(uint128 maxAmountIn, uint128 minRateE18, uint24 feeBps)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(
            PolicyEnvelope.build(maxAmountIn, minRateE18), FeeFlatIn.build(feeBps), XYCSwap.build()
        );
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

    /// @dev In Aqua mode the shipped strategy is the encoded order itself, so the Aqua strategy
    ///   hash and the SwapVM order hash are the same value.
    function _ship(ISwapVM.Order memory order) internal returns (bytes32 strategyHash) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE_A;
        amounts[1] = RESERVE_B;

        vm.prank(maker);
        strategyHash = aqua.ship(address(swapVM), abi.encode(order), tokens, amounts);
        assertEq(strategyHash, swapVM.hash(order), "Aqua strategy hash is the SwapVM order hash");
    }

    function _takerData() internal view returns (bytes memory) {
        return _takerData(true, "");
    }

    /// @dev exactOut needs a threshold, otherwise the router caps the input it will spend.
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

    /// @notice A mandate that does not bind leaves the strategy behaviour untouched.
    function test_WithinMandateSettlesNormally() public {
        ISwapVM.Order memory order = _order(_program(100e18, 1.9e18, 0.003e7));
        _ship(order);

        uint256 before = tokenB.balanceOf(address(this));
        (uint256 amountIn, uint256 amountOut,) = swapVM.swap(order, 10e18, _takerData());

        assertEq(amountIn, 10e18, "input as requested");
        assertGt(amountOut, 19e18, "constant product minus the 0.3% fee");
        assertEq(tokenB.balanceOf(address(this)) - before, amountOut, "taker received output");

        // Aqua never took custody: the reserve sat in the maker wallet the whole time.
        assertEq(tokenA.balanceOf(maker), RESERVE_A + amountIn, "maker received input");
    }

    /// @notice The size cap binds even though the pool could serve the trade.
    function test_RevertWhenOverCap() public {
        ISwapVM.Order memory order = _order(_program(100e18, 1.5e18, 0.003e7));
        _ship(order);

        bytes memory takerData = _takerData();
        vm.expectPartialRevert(PolicyEnvelope.MandateAmountInExceeded.selector);
        swapVM.swap(order, 200e18, takerData);
    }

    /// @notice A price under the mandate floor is refused inside the VM.
    function test_RevertWhenBelowFloorRate() public {
        ISwapVM.Order memory order = _order(_program(100e18, 2.5e18, 0.003e7));
        _ship(order);

        bytes memory takerData = _takerData();
        vm.expectPartialRevert(PolicyEnvelope.MandateRateTooLow.selector);
        swapVM.swap(order, 10e18, takerData);
    }

    /// @notice The point of wrapping. FeeFlatIn sits AFTER the envelope in program order, yet it
    ///   executes inside it, so the envelope judges the price the taker actually gets. A guard
    ///   that merely ran first would have passed before the fee ever touched the amounts.
    function test_FeeBehindTheGuardStillCounted() public {
        // 0.3% fee leaves the rate around 1.974, comfortably above a 1.9 floor.
        ISwapVM.Order memory ok = _order(_program(100e18, 1.9e18, 0.003e7));
        _ship(ok);
        (, uint256 amountOut,) = swapVM.swap(ok, 10e18, _takerData());
        assertGt(amountOut, 19.7e18, "small fee stays inside the mandate");

        // Same mandate, same floor, but a 5% fee drags the rate below it.
        ISwapVM.Order memory tooExpensive = _order(_program(100e18, 1.9e18, 0.05e7));
        _ship(tooExpensive);

        bytes memory takerData = _takerData();
        vm.expectPartialRevert(PolicyEnvelope.MandateRateTooLow.selector);
        swapVM.swap(tooExpensive, 10e18, takerData);
    }

    /// @notice exactOut is the direction the wrapping design exists for. The taker fixes the
    ///   output and the VM computes the input, so `amountIn` is only known once the curve has run.
    ///   A guard reading the register before that would be inspecting the taker's untouched zero.
    function test_ExactOutSettlesInsideMandate() public {
        ISwapVM.Order memory order = _order(_program(100e18, 1.9e18, 0.003e7));
        _ship(order);

        uint256 before = tokenB.balanceOf(address(this));
        bytes memory takerData = _takerData(false, abi.encodePacked(bytes32(type(uint256).max)));
        (uint256 amountIn, uint256 amountOut,) = swapVM.swap(order, 19e18, takerData);

        assertEq(amountOut, 19e18, "output as requested");
        assertGt(amountIn, 9e18, "input computed by the curve");
        assertLe(amountIn, 100e18, "and inside the cap");
        assertEq(tokenB.balanceOf(address(this)) - before, amountOut, "taker received output");
    }

    /// @notice The cap still binds in exactOut, where the taker never states an input at all.
    function test_ExactOutRevertsWhenComputedInputExceedsCap() public {
        // Asking for 300 out against a 2000 reserve needs far more than the 100 cap allows in.
        ISwapVM.Order memory order = _order(_program(100e18, 1e18, 0.003e7));
        _ship(order);

        bytes memory takerData = _takerData(false, abi.encodePacked(bytes32(type(uint256).max)));
        vm.expectPartialRevert(PolicyEnvelope.MandateAmountInExceeded.selector);
        swapVM.swap(order, 300e18, takerData);
    }

    /// @notice And the floor price binds in exactOut too.
    function test_ExactOutRevertsWhenBelowFloorRate() public {
        ISwapVM.Order memory order = _order(_program(100e18, 2.5e18, 0.003e7));
        _ship(order);

        bytes memory takerData = _takerData(false, abi.encodePacked(bytes32(type(uint256).max)));
        vm.expectPartialRevert(PolicyEnvelope.MandateRateTooLow.selector);
        swapVM.swap(order, 19e18, takerData);
    }

    /// @notice Expiry is not duplicated into PolicyEnvelope. SwapVM already ships `Deadline`, and
    ///   the whole point of a composable instruction set is to reach for what exists. Placed
    ///   inside the envelope it gives the mandate its third term: a size cap, a floor price, and
    ///   a time after which the grant authorises nothing.
    function test_DeadlineComposesWithTheEnvelope() public {
        uint40 expiry = uint40(block.timestamp + 2 hours);
        bytes memory program = bytes.concat(
            PolicyEnvelope.build(100e18, 1.9e18),
            Deadline.build(expiry),
            FeeFlatIn.build(0.003e7),
            XYCSwap.build()
        );
        ISwapVM.Order memory order = _order(program);
        _ship(order);

        // Inside the window the mandate settles as usual.
        (, uint256 amountOut,) = swapVM.swap(order, 10e18, _takerData());
        assertGt(amountOut, 19e18, "settles before expiry");

        // Past it, the grant authorises nothing at all.
        vm.warp(uint256(expiry) + 1);
        bytes memory takerData = _takerData();
        vm.expectPartialRevert(Deadline.DeadlineReached.selector);
        swapVM.swap(order, 10e18, takerData);
    }
}
