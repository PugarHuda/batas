// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { StaticBalances } from "@1inch/swap-vm/src/instructions/Balances.sol";
import { LimitSwap } from "@1inch/swap-vm/src/instructions/LimitSwap.sol";
import { FeeFlatOut } from "@1inch/swap-vm/src/instructions/FeeFlat.sol";

import { AmanatRouter } from "../src/AmanatRouter.sol";
import { PolicyEnvelope } from "../src/PolicyEnvelope.sol";

contract PolicyEnvelopeTest is Test {
    AmanatRouter internal swapVM;
    TokenMock internal tokenA;
    TokenMock internal tokenB;

    uint256 internal makerPK = 0xA11CE;
    address internal maker;

    uint256 internal constant BAL_IN = 1_000e18;
    uint256 internal constant BAL_OUT = 2_000e18; // opening rate 2.0

    function setUp() public {
        maker = vm.addr(makerPK);
        swapVM = new AmanatRouter(address(0), address(0), address(this), "SwapVM", "1.0.0");

        tokenA = new TokenMock("A", "A");
        tokenB = new TokenMock("B", "B");
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);

        tokenA.mint(maker, 10_000e18);
        tokenB.mint(maker, 10_000e18);
        vm.startPrank(maker);
        tokenA.approve(address(swapVM), type(uint256).max);
        tokenB.approve(address(swapVM), type(uint256).max);
        vm.stopPrank();

        tokenA.mint(address(this), 10_000e18);
        tokenA.approve(address(swapVM), type(uint256).max);
        tokenB.approve(address(swapVM), type(uint256).max);
    }

    /// @dev PolicyEnvelope first, so it becomes the outermost frame of the program.
    function _program(uint128 maxAmountIn, uint128 minRateE18) internal view returns (bytes memory) {
        return bytes.concat(
            PolicyEnvelope.build(maxAmountIn, minRateE18),
            StaticBalances.build(BAL_IN, BAL_OUT),
            LimitSwap.build(address(tokenA), address(tokenB))
        );
    }

    /// @dev Same mandate, but a fee instruction runs after the swap curve and shrinks amountOut.
    function _programWithTrailingFee(uint128 maxAmountIn, uint128 minRateE18, uint24 feeBps)
        internal
        view
        returns (bytes memory)
    {
        return bytes.concat(
            PolicyEnvelope.build(maxAmountIn, minRateE18),
            StaticBalances.build(BAL_IN, BAL_OUT),
            LimitSwap.build(address(tokenA), address(tokenB)),
            FeeFlatOut.build(feeBps)
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
                useAquaInsteadOfSignature: false,
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

    function _takerData(ISwapVM.Order memory order) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPK, swapVM.hash(order));
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(0),
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: false,
                isAToB: true,
                allowPartialFill: false,
                threshold: bytes(""),
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
                signature: abi.encodePacked(r, s, v)
            })
        );
    }

    /// @notice A mandate that does not bind leaves the strategy behaviour untouched.
    function test_WithinMandateSettlesNormally() public {
        ISwapVM.Order memory order = _order(_program(100e18, 1.5e18));
        (uint256 amountIn, uint256 amountOut,) = swapVM.swap(order, 10e18, _takerData(order));

        assertEq(amountIn, 10e18, "input as requested");
        assertEq(amountOut, 20e18, "output at the 2.0 opening rate");
    }

    /// @notice The size cap binds even though the maker has ample balance.
    function test_RevertWhenOverCap() public {
        ISwapVM.Order memory order = _order(_program(100e18, 1.5e18));
        bytes memory takerData = _takerData(order);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEnvelope.MandateAmountInExceeded.selector, 200e18, uint256(100e18))
        );
        swapVM.swap(order, 200e18, takerData);
    }

    /// @notice A price under the mandate floor is refused by the VM itself.
    function test_RevertWhenBelowFloorRate() public {
        ISwapVM.Order memory order = _order(_program(100e18, 2.5e18));
        bytes memory takerData = _takerData(order);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEnvelope.MandateRateTooLow.selector, uint256(20e18), uint256(10e18), uint256(2.5e18)
            )
        );
        swapVM.swap(order, 10e18, takerData);
    }

    /// @notice The point of wrapping: an instruction placed AFTER the swap curve still cannot
    ///   push the settlement outside the mandate. A sequential guard sitting after the curve
    ///   would have already passed by the time this fee shrank the output.
    function test_TrailingInstructionCannotEscapeTheEnvelope() public {
        // 10% out-fee turns the 2.0 rate into 1.8, below the 1.9 floor.
        ISwapVM.Order memory order = _order(_programWithTrailingFee(100e18, 1.9e18, 0.1e7));
        bytes memory takerData = _takerData(order);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEnvelope.MandateRateTooLow.selector, uint256(18e18), uint256(10e18), uint256(1.9e18)
            )
        );
        swapVM.swap(order, 10e18, takerData);
    }

    /// @notice The same trailing fee is fine when it still lands inside the mandate.
    function test_TrailingFeeAllowedWhenStillInsideMandate() public {
        ISwapVM.Order memory order = _order(_programWithTrailingFee(100e18, 1.7e18, 0.1e7));
        (, uint256 amountOut,) = swapVM.swap(order, 10e18, _takerData(order));
        assertEq(amountOut, 18e18, "output net of the trailing fee");
    }
}
