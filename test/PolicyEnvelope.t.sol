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

import { BatasRouter } from "../src/BatasRouter.sol";
import { PolicyEnvelope } from "../src/PolicyEnvelope.sol";
import { MandateName } from "../src/MandateName.sol";

/// @dev Aqua-backed mode: the maker ships liquidity to the router and the encoded order is the
///   Aqua strategy, so no signature is involved at all. Balances come from Aqua rather than from
///   a balance instruction, which is why AquaOpcodes carries none.
contract PolicyEnvelopeTest is Test {
    Aqua internal aqua;
    BatasRouter internal swapVM;
    TokenMock internal tokenA;
    TokenMock internal tokenB;

    address internal maker = makeAddr("maker");

    uint256 internal constant RESERVE_A = 1_000e18;
    uint256 internal constant RESERVE_B = 2_000e18; // opening rate 2.0

    uint24 internal constant BPS = 1e7;

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

    /// @notice Every route around the mandate, tried and closed.
    /// @dev The rest of this file checks one refusal per test, which is right for a suite and wrong
    ///   for answering the question anyone actually asks: *so what can an attacker do?* This walks
    ///   the whole list against one funded position and shows each door shut.
    ///
    ///   Run it with `-vv` to watch: it is the demo, and it is also a test, so it cannot rot into a
    ///   story the code stopped telling.
    function test_EveryRouteAroundTheMandateIsClosed() public {
        ISwapVM.Order memory order = _order(_program(100e18, 1.9e18, 0.003e7));
        _ship(order);

        emit log("a mandate: at most 100 in, never under 1.9 out per 1 in");
        emit log("");

        // 1. Inside the terms. This one is supposed to work, and if it does not the rest proves
        //    nothing — a position that refuses everything is not enforcing a mandate, it is broken.
        (, uint256 out,) = swapVM.quote(order, 10e18, _takerData());
        assertGt(out, 19e18);
        emit log_named_uint("10 in, inside every limit                -> settles, out", out);

        // 2. Bigger than the cap.
        try swapVM.quote(order, 101e18, _takerData()) returns (uint256, uint256, bytes32) {
            fail();
        } catch {
            emit log("101 in, over the size cap                -> refused");
        }

        // 3. Big enough that the curve walks the price under the floor, while staying under the cap.
        //    This is the one a size cap alone would let through.
        try swapVM.quote(order, 90e18, _takerData()) returns (uint256, uint256, bytes32) {
            fail();
        } catch {
            emit log("90 in, under the cap but under the floor -> refused");
        }

        // 4. Asking by output instead of by input. The input is only known after the curve runs, so
        //    a guard placed before it would have nothing to check.
        try swapVM.quote(order, 190e18, _takerData(false, abi.encode(type(uint256).max))) returns (uint256, uint256, bytes32) {
            fail();
        } catch {
            emit log("190 out, exactOut around the cap         -> refused");
        }

        // 5. Waiting for the terms to lapse does not widen them either; it closes them.
        //    (No deadline in this program, so the expiry route is pinned in its own test.)

        // 6. Rewriting the mandate. An attacker can build any program they like — but the terms are
        //    the strategy hash, so a widened cap is a different position, and the maker never
        //    shipped a token to it. This is the property that makes the limits immutable rather
        //    than merely checked.
        ISwapVM.Order memory widened = _order(_program(1_000e18, 0, 0.003e7));
        assertTrue(swapVM.hash(widened) != swapVM.hash(order), "different terms must be a different position");
        try swapVM.quote(widened, 500e18, _takerData()) returns (uint256, uint256, bytes32) {
            fail();
        } catch {
            emit log("terms rewritten to remove the limits     -> a position with no reserves");
        }
    }

    /// @notice A truncated name check is refused rather than half-read, for the same reason.
    /// @dev `InstructionArgs` performs no bounds validation, so a `MandateName` that declares fewer
    ///   bytes than it needs reads its registry address out of whatever follows it in calldata. A
    ///   misparsed fee produces a wrong price and somebody notices; a guard pointed at the wrong
    ///   registry produces a guard that passes, and asking a contract that is not a registry is how
    ///   a kill switch stops killing anything.
    function test_RevertWhenNameArgsAreTruncated() public {
        // [opcode 0x22][len 40] — one byte short of the registry, holder and length byte it needs.
        bytes memory short = bytes.concat(
            bytes1(0x22), bytes1(0x28), bytes20(address(0xBEEF)), bytes20(address(0xCAFE)),
            FeeFlatIn.build(0.003e7),
            XYCSwap.build()
        );
        ISwapVM.Order memory order = _order(short);
        _ship(order);
        bytes memory takerData = _takerData();
        vm.expectPartialRevert(MandateName.MandateNameArgsTruncated.selector);
        swapVM.swap(order, 10e18, takerData);
    }

    /// @notice And one whose label runs off the end of its own arguments.
    function test_RevertWhenNameLabelRunsPastItsArgs() public {
        // A full header, a length byte claiming 200 label bytes, and none of them present.
        bytes memory lying = bytes.concat(
            bytes1(0x22), bytes1(0x29), bytes20(address(0xBEEF)), bytes20(address(0xCAFE)), bytes1(uint8(200)),
            FeeFlatIn.build(0.003e7),
            XYCSwap.build()
        );
        ISwapVM.Order memory order = _order(lying);
        _ship(order);
        bytes memory takerData = _takerData();
        vm.expectPartialRevert(MandateName.MandateNameArgsTruncated.selector);
        swapVM.swap(order, 10e18, takerData);
    }

    /// @notice What the guard costs, measured rather than asserted to be small.
    /// @dev A policy nobody can afford to enforce is a policy nobody enforces. Two settlements over
    ///   the same reserves and the same trade, one with the envelope wrapped around the program and
    ///   one without it, so the difference is the instruction and nothing else.
    ///
    ///   The bound is deliberately loose and deliberately present. Loose, because an exact number
    ///   would go red on any compiler bump and teach the next person to delete the test. Present,
    ///   because the envelope calls `runLoop` and inspects the settled registers, and an
    ///   implementation that quietly started re-walking the program would show up here as nothing
    ///   else in this suite would notice it.
    function test_TheGuardCostsAlmostNothing() public {
        ISwapVM.Order memory guarded = _order(_program(100e18, 1.9e18, 0.003e7));
        // Same program, same terms, envelope removed. A different program is a different strategy
        // hash, so Aqua accepts it as its own position rather than as a re-ship.
        ISwapVM.Order memory bare = _order(bytes.concat(FeeFlatIn.build(0.003e7), XYCSwap.build()));
        _ship(guarded);
        _ship(bare);

        // One settlement on each before measuring. The first swap against a position writes cold
        // storage all over Aqua and the router, and the first version of this test read that as the
        // guard costing 14,590 gas — a number that was mostly the price of being first.
        swapVM.swap(guarded, 1e18, _takerData());
        swapVM.swap(bare, 1e18, _takerData());

        uint256 before = gasleft();
        swapVM.swap(guarded, 10e18, _takerData());
        uint256 withGuard = before - gasleft();

        before = gasleft();
        swapVM.swap(bare, 10e18, _takerData());
        uint256 withoutGuard = before - gasleft();

        emit log_named_uint("gas, guarded    ", withGuard);
        emit log_named_uint("gas, unguarded  ", withoutGuard);
        emit log_named_uint("the guard costs ", withGuard - withoutGuard);

        assertGt(withGuard, withoutGuard, "the guard cannot be free; if it is, it is not running");
        assertLt(withGuard - withoutGuard, 5_000, "the guard has started doing real work");
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

    /// @notice An envelope whose args are shorter than its two limits is refused, not half-read.
    /// @dev `InstructionArgs.at` is a raw `calldataload`; 1inch documents that the library "does
    ///   not implement out-of-bounds read validations", leaving arg length to whoever built the
    ///   program. For a fee or a curve that is fine — a misparse produces a wrong price and
    ///   somebody notices. For this instruction it produces a *guard that passes*.
    ///
    ///   The program below proves what would otherwise happen. Its envelope declares sixteen bytes
    ///   of args instead of thirty-two, so `minRateE18` is read from the sixteen bytes that follow:
    ///   the fee instruction's header and the start of the curve. Removing the check and running
    ///   this test gives a floor of 148889121703133190954033214317794426880 — a position that
    ///   refuses every trade.
    ///
    ///   That direction is an accident of this layout, and that is the argument. The value comes
    ///   from whatever bytes happen to sit after the envelope; a different program yields a floor
    ///   near zero and an envelope that waves everything through, and an envelope that is the last
    ///   instruction reads past `order.data` entirely. A guard whose strictness depends on its
    ///   neighbours is not a guard, so the length is checked rather than reasoned about.
    function test_RevertWhenEnvelopeArgsAreTruncated() public {
        // Hand-built on purpose: PolicyEnvelope.build cannot express this, which is the point.
        // [opcode 0x21][len 16][16 bytes of maxAmountIn] then the rest of an ordinary program.
        bytes memory truncated = bytes.concat(
            bytes1(0x21), bytes1(0x10), bytes16(uint128(100e18)),
            FeeFlatIn.build(0.003e7),
            XYCSwap.build()
        );
        ISwapVM.Order memory order = _order(truncated);
        _ship(order);

        bytes memory takerData = _takerData();
        vm.expectPartialRevert(PolicyEnvelope.MandateArgsTruncated.selector);
        swapVM.swap(order, 10e18, takerData);
    }

    /// @notice Exactly thirty-two bytes is accepted; the check is a floor, not a fixed width.
    function test_ExactlyThirtyTwoArgBytesIsAccepted() public {
        ISwapVM.Order memory order = _order(_program(100e18, 1.9e18, 0.003e7));
        _ship(order);

        bytes memory takerData = _takerData();
        (uint256 amountIn,,) = swapVM.swap(order, 10e18, takerData);
        assertEq(amountIn, 10e18, "a well formed envelope still settles");
    }
}
