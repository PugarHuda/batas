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
import { Deadline, Stop } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { Jump } from "@1inch/swap-vm/src/instructions/Jumps.sol";
import { ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";

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
            PolicyEnvelope.build(maxAmountIn, minRateE18, true), FeeFlatIn.build(feeBps), XYCSwap.build()
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

    /// @notice Two envelopes compose, and the tighter one wins whichever is outer.
    /// @dev This is what a wrapping instruction buys that a sequential check cannot: a delegation
    ///   chain for free. A DAO's terms outside, the agent's tighter terms inside — or the other way
    ///   round — and the inner can never exceed the outer, because both frames judge the same
    ///   settled registers. Nothing in the contracts was written for this; it falls out.
    function test_NestedEnvelopesCanOnlyTighten() public {
        // Outer wide, inner tight: the inner cap binds.
        bytes memory innerTight = bytes.concat(
            PolicyEnvelope.build(1_000e18, 0, true),
            PolicyEnvelope.build(100e18, 1.9e18, true),
            FeeFlatIn.build(0.003e7),
            XYCSwap.build()
        );
        ISwapVM.Order memory a = _order(innerTight);
        _ship(a);
        (, uint256 out,) = swapVM.quote(a, 10e18, _takerData());
        assertGt(out, 19e18, "inside both limits settles");
        bytes memory td = _takerData();
        vm.expectPartialRevert(PolicyEnvelope.MandateAmountInExceeded.selector);
        swapVM.quote(a, 150e18, td);

        // Outer tight, inner wide: the outer cap binds, and the inner cannot loosen it.
        bytes memory outerTight = bytes.concat(
            PolicyEnvelope.build(100e18, 1.9e18, true),
            PolicyEnvelope.build(1_000e18, 0, true),
            FeeFlatIn.build(0.003e7),
            XYCSwap.build()
        );
        ISwapVM.Order memory b = _order(outerTight);
        _ship(b);
        vm.expectPartialRevert(PolicyEnvelope.MandateAmountInExceeded.selector);
        swapVM.quote(b, 150e18, td);
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
            PolicyEnvelope.build(100e18, 1.9e18, true),
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

    /// @notice There is no "after" the envelope. An instruction appended past the curve still runs
    ///   inside the frame and is judged there; one placed past a jump never runs; a stray byte
    ///   or a `Stop` is refused before anything settles.
    /// @dev SwapVM bytecode has no closing bracket. A wrapping instruction's inner `runLoop`
    ///   consumes the program to its end, and when it returns the outer loop reads the same
    ///   program counter and finds nothing left. So `[PolicyEnvelope [Deadline, XYCSwap]] FeeFlatIn`
    ///   is not a program with a fee outside the envelope — it is the program
    ///   `[PolicyEnvelope [Deadline, XYCSwap, FeeFlatIn]]`, whatever the brackets in the author's
    ///   head said. The question is then whether a fee *behind* the curve can move the settled
    ///   amounts, and the answer differs by mode, which is why both are pinned:
    ///
    ///    - exactIn: `FeeFlatIn` takes its cut, runs the (now empty) rest of the program, sees
    ///      nothing inside it moved `amountIn`, and gives the cut back. A trailing fee is a no-op
    ///      and the router settles exactly what the bare program would.
    ///    - exactOut: `FeeFlatIn` grosses `amountIn` up after its empty inner loop, so the trailing
    ///      fee *does* change the amounts — and the envelope, whose own inner loop ran the fee,
    ///      judges the grossed-up number. Inside the terms it settles at the inflated input;
    ///      outside them it is refused.
    ///
    ///   The other two shapes are refusals rather than judgements. `Stop` is not in the Aqua
    ///   instruction set this router extends, so a program that tries to close the frame early
    ///   never runs at all; and a half instruction after the curve trips the VM's own bounds check.
    ///   The only way to put bytes after the frame is a `Jump` to the end of the program, and those
    ///   bytes are then dead — the settlement is the bare program's to the wei.
    ///
    ///   Fails if the router ever resumed the outer loop after a wrapper returned, if the envelope
    ///   read the registers before its inner loop instead of after, or if `FeeFlatIn` stopped
    ///   restoring its cut when nothing inside it moved the input.
    function test_NothingRunsOutsideTheEnvelopeFrame() public {
        uint40 expiry = uint40(block.timestamp + 2 hours);
        bytes memory envelope = PolicyEnvelope.build(100e18, 1.9e18, true);
        bytes memory inside = bytes.concat(Deadline.build(expiry), XYCSwap.build());
        bytes memory bare = bytes.concat(envelope, inside);
        bytes memory trailingFee = bytes.concat(bare, FeeFlatIn.build(0.1e7));
        bytes memory trailingCurve = bytes.concat(bare, XYCSwap.build());
        bytes memory jumpedOver = bytes.concat(bare, Jump.build(uint16(bare.length + Jump.sizeOf(0) + FeeFlatIn.sizeOf(0))), FeeFlatIn.build(0.1e7));
        bytes memory stopped = bytes.concat(bare, Stop.build(), FeeFlatIn.build(0.1e7));
        bytes memory halfInstruction = bytes.concat(bare, bytes1(uint8(FeeFlatIn.opcode)));
        // Same trailing fee, terms wide enough that the grossed-up input still fits.
        bytes memory roomy = bytes.concat(PolicyEnvelope.build(1_000e18, 0, true), inside, FeeFlatIn.build(0.1e7));

        ISwapVM.Order memory oBare = _order(bare);
        ISwapVM.Order memory oFee = _order(trailingFee);
        ISwapVM.Order memory oCurve = _order(trailingCurve);
        ISwapVM.Order memory oJump = _order(jumpedOver);
        ISwapVM.Order memory oStop = _order(stopped);
        ISwapVM.Order memory oHalf = _order(halfInstruction);
        ISwapVM.Order memory oRoomy = _order(roomy);
        _ship(oBare); _ship(oFee); _ship(oCurve); _ship(oJump); _ship(oStop); _ship(oHalf); _ship(oRoomy);

        bytes memory exactIn = _takerData();
        bytes memory exactOut = _takerData(false, abi.encodePacked(bytes32(type(uint256).max)));

        // exactIn: the trailing fee and the trailing curve change nothing.
        (, uint256 bareOut,) = swapVM.quote(oBare, 10e18, exactIn);
        (, uint256 feeOut,) = swapVM.quote(oFee, 10e18, exactIn);
        (, uint256 curveOut,) = swapVM.quote(oCurve, 10e18, exactIn);
        (, uint256 jumpOut,) = swapVM.quote(oJump, 10e18, exactIn);
        assertEq(feeOut, bareOut, "exactIn: a fee behind the curve restores its own cut");
        assertEq(curveOut, bareOut, "exactIn: a second curve re-prices the same registers to the same number");
        assertEq(jumpOut, bareOut, "exactIn: bytes past a jump to the end are dead");

        // exactOut: the trailing fee grosses the input up, and that is the number the envelope judges.
        (uint256 bareIn,,) = swapVM.quote(oBare, 19e18, exactOut);
        (uint256 roomyIn,,) = swapVM.quote(oRoomy, 19e18, exactOut);
        (uint256 jumpIn,,) = swapVM.quote(oJump, 19e18, exactOut);
        assertEq(roomyIn, bareIn + (bareIn * 0.1e7 + (1e7 - 0.1e7) - 1) / (1e7 - 0.1e7), "exactOut: the trailing fee is settled, grossed up exactly as FeeFlatIn computes it");
        assertEq(jumpIn, bareIn, "exactOut: bytes past a jump to the end are dead");
        vm.expectPartialRevert(PolicyEnvelope.MandateRateTooLow.selector);
        swapVM.quote(oFee, 19e18, exactOut);

        // The two shapes the router refuses outright, in either mode.
        vm.expectRevert(abi.encodeWithSelector(AquaOpcodes.UnknownOpcode.selector, uint256(Stop.opcode)));
        swapVM.quote(oStop, 10e18, exactIn);
        // (Its length byte is read from whatever calldata follows the program, so only the
        // selector is pinned.)
        vm.expectPartialRevert(ContextLib.RunLoopExceedProgramLength.selector);
        swapVM.quote(oHalf, 10e18, exactIn);
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
        // (A full envelope is 33 bytes now; this one stops after the cap.)
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

    // --- boundaries -----------------------------------------------------------------------------
    //
    // The refusals above are one step past a limit and matched by selector only. These stand on the
    // limit itself, in both modes, and pin the full revert bytes one wei past it: the numbers the
    // envelope reports are the numbers it judged, which is what an agent decoding a refusal reads.

    /// @notice exactIn: an input of exactly the cap settles; one wei more is refused, by its numbers.
    function test_ExactlyTheCapSettlesAndOneWeiMoreIsRefused() public {
        ISwapVM.Order memory order = _order(_program(100e18, 1.5e18, 0.003e7));
        _ship(order);

        bytes memory takerData = _takerData();
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEnvelope.MandateAmountInExceeded.selector, uint256(100e18) + 1, uint256(100e18))
        );
        swapVM.quote(order, 100e18 + 1, takerData);

        (uint256 amountIn,,) = swapVM.swap(order, 100e18, _takerData());
        assertEq(amountIn, 100e18, "the cap itself is inside the mandate");
    }

    /// @notice exactIn: a trade exactly on the floor settles; a floor one wei higher refuses it.
    /// @dev An input of 1e18 turns the cross-multiplication into `amountOut >= minRateE18`, so the
    ///   floor can be set to the trade's own output. The output comes from an unbounded position
    ///   over the same reserves and the same fee, because the envelope does not change pricing.
    function test_ExactlyTheFloorSettlesAndOneWeiHigherIsRefused() public {
        ISwapVM.Order memory unbounded = _order(_program(type(uint128).max, 0, 0.003e7));
        _ship(unbounded);
        (, uint256 amountOut,) = swapVM.quote(unbounded, 1e18, _takerData());

        ISwapVM.Order memory tooHigh = _order(_program(100e18, uint128(amountOut + 1), 0.003e7));
        _ship(tooHigh);
        bytes memory takerData = _takerData();
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEnvelope.MandateRateTooLow.selector, amountOut, uint256(1e18), amountOut + 1)
        );
        swapVM.quote(tooHigh, 1e18, takerData);

        ISwapVM.Order memory onTheFloor = _order(_program(100e18, uint128(amountOut), 0.003e7));
        _ship(onTheFloor);
        (, uint256 settled,) = swapVM.swap(onTheFloor, 1e18, _takerData());
        assertEq(settled, amountOut, "a trade exactly on the floor is allowed");
    }

    /// @notice exactOut: the input the curve computes may equal the cap, and may land on the
    ///   tightest floor it clears; one wei tighter either way is refused with the computed input.
    /// @dev This is the mode the wrapping design exists for, and until now it was only tested well
    ///   inside or well outside the terms. On the boundary the envelope has to be reading the
    ///   input *after* `FeeFlatIn` grossed it up and `XYCSwap` rounded it toward the maker; reading
    ///   it anywhere earlier would put the refusal a few wei off, and only this position sees that.
    function test_ExactOutOnTheCapAndOnTheFloor() public {
        uint256 amountOut = 19e18;
        bytes memory exactOut = _takerData(false, abi.encodePacked(bytes32(type(uint256).max)));

        ISwapVM.Order memory unbounded = _order(_program(type(uint128).max, 0, 0.003e7));
        _ship(unbounded);
        (uint256 amountIn,,) = swapVM.quote(unbounded, amountOut, exactOut);

        // The cap.
        ISwapVM.Order memory underCap = _order(_program(uint128(amountIn - 1), 0, 0.003e7));
        _ship(underCap);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEnvelope.MandateAmountInExceeded.selector, amountIn, amountIn - 1)
        );
        swapVM.quote(underCap, amountOut, exactOut);

        ISwapVM.Order memory onCap = _order(_program(uint128(amountIn), 0, 0.003e7));
        _ship(onCap);
        (uint256 settledIn, uint256 settledOut,) = swapVM.swap(onCap, amountOut, exactOut);
        assertEq(settledIn, amountIn, "exactOut may spend exactly the cap");
        assertEq(settledOut, amountOut);

        // The floor. The rate is not a whole number of wei, so the tightest floor that clears is the
        // rounded-down one, and one above it is the first that does not.
        uint256 tightest = amountOut * 1e18 / amountIn;

        ISwapVM.Order memory overFloor = _order(_program(100e18, uint128(tightest + 1), 0.003e7));
        _ship(overFloor);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEnvelope.MandateRateTooLow.selector, amountOut, amountIn, tightest + 1)
        );
        swapVM.quote(overFloor, amountOut, exactOut);

        ISwapVM.Order memory onFloor = _order(_program(100e18, uint128(tightest), 0.003e7));
        _ship(onFloor);
        (settledIn,,) = swapVM.quote(onFloor, amountOut, exactOut);
        assertEq(settledIn, amountIn, "the tightest floor the trade clears still settles it");
    }

    /// @notice The deadline second settles inside the envelope; the refusal one second later names
    ///   the deadline it read.
    /// @dev `test_DeadlineComposesWithTheEnvelope` checks a second past the expiry by selector. The
    ///   mandate's expiry is inclusive on both surfaces, and this is the VM half of that claim with
    ///   the envelope wrapped around it, rather than the bare `Deadline` 1inch already tests.
    function test_TheDeadlineSecondSettlesInsideTheEnvelope() public {
        uint40 expiry = uint40(block.timestamp + 2 hours);
        ISwapVM.Order memory order = _order(
            bytes.concat(
                PolicyEnvelope.build(100e18, 1.9e18, true), Deadline.build(expiry), FeeFlatIn.build(0.003e7), XYCSwap.build()
            )
        );
        _ship(order);

        vm.warp(expiry);
        (, uint256 amountOut,) = swapVM.swap(order, 10e18, _takerData());
        assertGt(amountOut, 19e18, "the deadline second is still inside the mandate");

        vm.warp(uint256(expiry) + 1);
        bytes memory takerData = _takerData();
        vm.expectRevert(abi.encodeWithSelector(Deadline.DeadlineReached.selector, uint256(expiry)));
        swapVM.quote(order, 10e18, takerData);
    }
}
