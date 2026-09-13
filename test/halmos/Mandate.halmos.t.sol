// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { BatasApp } from "../../src/BatasApp.sol";
import { Mandate, MandateLib } from "../../src/Mandate.sol";
import { PolicyEnvelope } from "../../src/PolicyEnvelope.sol";
import { MandateName } from "../../src/MandateName.sol";

/// @dev Halmos symbolic tests. Every `check_` here is a proof over ALL values of its parameters
///   (within the stated `vm.assume` bounds), not a fuzz. Run with `npm run verify:symbolic`.
///
///   The library calls are `internal`, so they run inline; the harness contracts below exist only
///   to turn a revert into a `catch` branch so both outcomes can be asserted against a spec.
contract EnvelopeHarness {
    function parse(bytes calldata args) external pure returns (uint128, uint128, bool) {
        return PolicyEnvelope.parse(args);
    }

    /// @dev Skip the 2-byte [opcode][len] header a `build` emits and parse the rest.
    function parseProgram(bytes calldata program) external pure returns (uint128, uint128, bool) {
        return PolicyEnvelope.parse(program[2:]);
    }
}

contract NameHarness {
    function parse(bytes calldata args) external pure returns (address, address, string memory) {
        return MandateName.parse(args);
    }

    function parseProgram(bytes calldata program) external pure returns (address, address, string memory) {
        return MandateName.parse(program[2:]);
    }

    /// @dev Same parse, but the label stays in calldata: returning `string memory` would be a
    ///   CALLDATACOPY of symbolic size, which halmos cannot execute. The slice itself is only
    ///   offset arithmetic plus Solidity's own bounds check, so nothing is lost.
    function parseHead(bytes calldata args) external pure returns (address registry, address holder, uint256 len) {
        string calldata label;
        (registry, holder, label) = MandateName.parse(args);
        len = bytes(label).length;
    }

    function build(address registry, address holder, string calldata label) external pure returns (bytes memory) {
        return MandateName.build(registry, holder, label);
    }
}

contract CompileHarness {
    function compile(Mandate memory m) external pure returns (bytes memory) {
        return MandateLib.toProgram(m);
    }
}

contract AppHarness is BatasApp {
    constructor() BatasApp(IAqua(address(0))) { }

    function checkMandate(Mandate calldata m, uint256 amountIn, uint256 amountOut) external view {
        _checkMandate(m, amountIn, amountOut);
    }
}

contract MandateSymbolicTest is Test {
    uint256 internal constant BPS = 1e7;
    uint256 internal constant E18 = 1e18;
    /// @dev Bound on balances and amounts so `net * balanceOut` and `amountOut * 1e18` cannot
    ///   overflow: 2^120 wei is ~1.3e36, a million times any token supply that exists.
    uint256 internal constant AMOUNT_BOUND = 2 ** 120;

    EnvelopeHarness internal envelope;
    NameHarness internal name;
    CompileHarness internal compiler;
    AppHarness internal app;

    function setUp() public {
        envelope = new EnvelopeHarness();
        name = new NameHarness();
        compiler = new CompileHarness();
        app = new AppHarness();
    }

    function _mandate(uint128 cap, uint128 minRate, uint64 expiry, uint24 feeBps) internal pure returns (Mandate memory m) {
        m = Mandate({
            maker: address(1),
            agent: address(2),
            tokenIn: address(3),
            tokenOut: address(4),
            maxAmountIn: cap,
            minRateE18: minRate,
            expiry: expiry,
            feeBps: feeBps,
            salt: 1,
            nameRegistry: address(0),
            nameHolder: address(0),
            nameLabel: ""
        });
    }

    // ------------------------------------------------------------------------------------------
    // 1. quoteExactIn and the app's floor
    // ------------------------------------------------------------------------------------------

    /// @notice `_checkMandate` (no name registry) accepts exactly the spec predicate:
    ///   amountIn != 0, amountOut != 0, now <= expiry, amountIn <= cap, out*1e18 >= in*minRate.
    ///   Sound (accept => floor holds) AND complete (floor holds => accept).
    function check_checkMandate_isExactlyTheSpec(
        uint128 cap,
        uint128 minRate,
        uint64 expiry,
        uint256 amountIn,
        uint256 amountOut
    ) public view {
        vm.assume(amountIn < AMOUNT_BOUND && amountOut < AMOUNT_BOUND);
        Mandate memory m = _mandate(cap, minRate, expiry, 0);

        bool spec = amountIn != 0 && amountOut != 0 && block.timestamp <= expiry && amountIn <= cap
            && amountOut * E18 >= amountIn * minRate;

        try app.checkMandate(m, amountIn, amountOut) {
            assert(spec);
        } catch {
            assert(!spec);
        }
    }

    /// @notice The quoted output, when the app accepts it, clears the floor; and any accepted quote
    ///   is at least what the rate promises. Ties quoteExactIn to _checkMandate end to end.
    function check_quote_acceptedByAppClearsFloor(
        uint128 cap,
        uint128 minRate,
        uint64 expiry,
        uint24 feeBps,
        uint256 balIn,
        uint256 balOut,
        uint256 amountIn
    ) public view {
        vm.assume(feeBps < BPS);
        vm.assume(balIn < AMOUNT_BOUND && balOut < AMOUNT_BOUND && amountIn < AMOUNT_BOUND);
        Mandate memory m = _mandate(cap, minRate, expiry, feeBps);

        uint256 out = MandateLib.quoteExactIn(m, balIn, balOut, amountIn);
        try app.checkMandate(m, amountIn, out) {
            assert(out * E18 >= amountIn * minRate);
            assert(amountIn <= cap && amountIn != 0 && out != 0);
        } catch { }
    }

    /// @notice With feeBps < BPS the fee never exceeds the input, so the subtraction cannot
    ///   underflow and the quote never reverts. (feeBps >= BPS is refused by toProgram; see 4.)
    function check_quote_neverRevertsBelowBasis(uint24 feeBps, uint256 balIn, uint256 balOut, uint256 amountIn)
        public
        pure
    {
        vm.assume(feeBps < BPS);
        vm.assume(balIn < AMOUNT_BOUND && balOut < AMOUNT_BOUND && amountIn < AMOUNT_BOUND);
        uint256 fee = (amountIn * feeBps + BPS - 1) / BPS;
        assert(fee <= amountIn);
    }

    /// @notice amountOut never exceeds balanceOut.
    function check_quote_neverExceedsBalanceOut(uint24 feeBps, uint256 balIn, uint256 balOut, uint256 amountIn)
        public
        pure
    {
        vm.assume(feeBps < BPS);
        vm.assume(balIn < AMOUNT_BOUND && balOut < AMOUNT_BOUND && amountIn < AMOUNT_BOUND);
        Mandate memory m = _mandate(0, 0, 0, feeBps);
        uint256 out = MandateLib.quoteExactIn(m, balIn, balOut, amountIn);
        assert(out <= balOut);
    }

    /// @notice More in never gives less out.
    function check_quote_monotone(uint24 feeBps, uint256 balIn, uint256 balOut, uint256 a1, uint256 a2)
        public
        pure
    {
        vm.assume(feeBps < BPS);
        vm.assume(balIn < AMOUNT_BOUND && balOut < AMOUNT_BOUND && a2 < AMOUNT_BOUND);
        vm.assume(a1 <= a2);
        Mandate memory m = _mandate(0, 0, 0, feeBps);
        assert(MandateLib.quoteExactIn(m, balIn, balOut, a1) <= MandateLib.quoteExactIn(m, balIn, balOut, a2));
    }

    /// @dev The three checks above multiply and divide two 256-bit symbols, which bit-blasting
    ///   solvers choke on. These pin the fee to the shipped default (0.3%) so one product becomes
    ///   linear; they are weaker statements (one fee, not all) and are reported as such.
    function check_quote_monotone_defaultFee(uint256 balIn, uint256 balOut, uint256 a1, uint256 a2) public pure {
        vm.assume(balIn < AMOUNT_BOUND && balOut < AMOUNT_BOUND && a2 < AMOUNT_BOUND);
        vm.assume(a1 <= a2);
        Mandate memory m = _mandate(0, 0, 0, 30_000);
        assert(MandateLib.quoteExactIn(m, balIn, balOut, a1) <= MandateLib.quoteExactIn(m, balIn, balOut, a2));
    }

    function check_quote_neverExceedsBalanceOut_defaultFee(uint256 balIn, uint256 balOut, uint256 amountIn)
        public
        pure
    {
        vm.assume(balIn < AMOUNT_BOUND && balOut < AMOUNT_BOUND && amountIn < AMOUNT_BOUND);
        Mandate memory m = _mandate(0, 0, 0, 30_000);
        assert(MandateLib.quoteExactIn(m, balIn, balOut, amountIn) <= balOut);
    }

    // ------------------------------------------------------------------------------------------
    // 2. PolicyEnvelope.parse
    // ------------------------------------------------------------------------------------------

    /// @notice For every args length (enumerated by --default-bytes-lengths) and every content:
    ///   length < 33 reverts; length >= 33 returns exactly bytes [0,16), [16,32), bit 7 of byte 32.
    function check_envelope_parse(bytes calldata args) public view {
        try envelope.parse(args) returns (uint128 cap, uint128 rate, bool dir) {
            assert(args.length >= 33);
            assert(cap == uint128(bytes16(args[0:16])));
            assert(rate == uint128(bytes16(args[16:32])));
            assert(dir == (uint8(args[32]) & 0x80 != 0));
        } catch {
            assert(args.length < 33);
        }
    }

    /// @notice build then parse is the identity, and the header is [0x21][33].
    function check_envelope_roundTrip(uint128 cap, uint128 rate, bool dir) public view {
        bytes memory program = PolicyEnvelope.build(cap, rate, dir);
        assert(program.length == 35);
        assert(program[0] == 0x21);
        assert(program[1] == 0x21); // 33 == 0x21, coincidentally the opcode too
        (uint128 cap2, uint128 rate2, bool dir2) = envelope.parseProgram(program);
        assert(cap2 == cap && rate2 == rate && dir2 == dir);
    }

    // ------------------------------------------------------------------------------------------
    // 3. MandateName.parse
    // ------------------------------------------------------------------------------------------

    /// @notice For every args length and content: reverts iff args.length < 41 + len (len being
    ///   byte 40, or the header check when there is no byte 40). On success, registry and holder
    ///   come from bytes [0,40) and the label is exactly the `len` bytes after the header — every
    ///   byte that reaches the result is inside `args`.
    function check_name_parse(bytes calldata args) public view {
        try name.parseHead(args) returns (address registry, address holder, uint256 labelLen) {
            assert(args.length >= 41);
            uint256 len = uint8(args[40]);
            assert(args.length >= 41 + len);
            assert(registry == address(bytes20(args[0:20])));
            assert(holder == address(bytes20(args[20:40])));
            assert(labelLen == len);
        } catch {
            assert(args.length < 41 || args.length < 41 + uint256(uint8(args[40])));
        }
    }

    /// @notice build then parse is the identity byte for byte (label lengths enumerated by the CLI).
    function check_name_roundTrip(address registry, address holder, string calldata label) public view {
        vm.assume(holder != address(0));
        vm.assume(bytes(label).length <= 214);
        bytes memory program = MandateName.build(registry, holder, label);
        assert(program[0] == 0x22);
        assert(uint8(program[1]) == 41 + bytes(label).length);
        (address r2, address h2, string memory l2) = name.parseProgram(program);
        assert(r2 == registry && h2 == holder);
        bytes memory a = bytes(label);
        bytes memory b = bytes(l2);
        assert(a.length == b.length);
        for (uint256 i = 0; i < a.length; i++) {
            assert(a[i] == b[i]);
        }
    }

    /// @notice A label longer than 214 bytes or a zero holder is refused at build time.
    function check_name_buildRefusesWhatCannotFit(address registry, address holder, string calldata label)
        public
        view
    {
        bool ok = holder != address(0) && bytes(label).length <= 214;
        try name.build(registry, holder, label) {
            assert(ok);
        } catch {
            assert(!ok);
        }
    }

    // ------------------------------------------------------------------------------------------
    // 4. MandateLib.toProgram
    // ------------------------------------------------------------------------------------------

    /// @notice For all terms: compiles iff feeBps < 1e7 and expiry <= uint40 max; when it does,
    ///   the program opens with [0x21][33] and the envelope decodes back to the mandate's terms
    ///   with direction == (tokenIn < tokenOut).
    function check_toProgram(
        uint128 cap,
        uint128 rate,
        uint64 expiry,
        uint24 feeBps,
        uint64 salt,
        address tokenIn,
        address tokenOut
    ) public view {
        Mandate memory m = _mandate(cap, rate, expiry, feeBps);
        m.salt = salt;
        m.tokenIn = tokenIn;
        m.tokenOut = tokenOut;

        bool ok = feeBps < BPS && expiry <= type(uint40).max;
        try compiler.compile(m) returns (bytes memory program) {
            assert(ok);
            assert(program[0] == 0x21);
            assert(uint8(program[1]) == 33);
            (uint128 cap2, uint128 rate2, bool dir2) = envelope.parseProgram(program);
            assert(cap2 == cap && rate2 == rate && dir2 == (tokenIn < tokenOut));
            // Deadline follows immediately: opcode 0x20, 5 bytes, big-endian expiry.
            assert(program[35] == 0x20 && uint8(program[36]) == 5);
            assert(uint40(bytes5(abi.encodePacked(program[37], program[38], program[39], program[40], program[41]))) == uint40(expiry));
        } catch {
            assert(!ok);
        }
    }

    // ------------------------------------------------------------------------------------------
    // 5. The agent's closed-form cap vs the on-chain floor
    // ------------------------------------------------------------------------------------------

    /// @dev Mirror of agent/swapvm.mjs decideMandate, before its haircut loop: exact closed form.
    function _closedForm(uint256 reserveA, uint256 reserveB, uint256 slipBps, uint256 feeBps)
        internal
        pure
        returns (uint256 minRate, uint256 maxIn)
    {
        uint256 spot = (reserveB * E18) / reserveA;
        minRate = (spot * (10_000 - slipBps)) / 10_000;
        uint256 slip = slipBps * 1000;
        if (slip > feeBps) {
            uint256 net = (reserveA * (slip - feeBps)) / (BPS - slip);
            maxIn = (net * BPS) / (BPS - feeBps);
        }
    }

    /// @notice The exact closed form, as the agent computes it BEFORE its haircut: does every
    ///   amountIn <= cap clear the floor? Expected: NO, by rounding — decideMandate documents this
    ///   and shaves the cap by a part in a million until `clearsFloor` holds. This check exists to
    ///   confirm the counterexample is a rounding hair, not a formula error. Defaults fixed:
    ///   slippage 200 bps, fee 0.3%.
    function check_closedForm_exactCapClearsFloor(uint256 reserveA, uint256 reserveB, uint256 amountIn) public pure {
        vm.assume(reserveA >= 1e6 && reserveA <= 1e30);
        vm.assume(reserveB >= 1e6 && reserveB <= 1e30);
        (uint256 minRate, uint256 maxIn) = _closedForm(reserveA, reserveB, 200, 30_000);
        vm.assume(amountIn != 0 && amountIn <= maxIn);
        Mandate memory m = _mandate(0, 0, 0, 30_000);
        uint256 out = MandateLib.quoteExactIn(m, reserveA, reserveB, amountIn);
        assert(out * E18 >= amountIn * minRate);
    }

    /// @notice The same with the agent's haircut applied once (cap * 999_999 / 1_000_000):
    ///   every amountIn at or under the shaved cap clears the floor.
    function check_closedForm_shavedCapClearsFloor(uint256 reserveA, uint256 reserveB, uint256 amountIn) public pure {
        vm.assume(reserveA >= 1e6 && reserveA <= 1e30);
        vm.assume(reserveB >= 1e6 && reserveB <= 1e30);
        (uint256 minRate, uint256 maxIn) = _closedForm(reserveA, reserveB, 200, 30_000);
        uint256 shaved = (maxIn * 999_999) / 1_000_000;
        vm.assume(amountIn != 0 && amountIn <= shaved);
        Mandate memory m = _mandate(0, 0, 0, 30_000);
        uint256 out = MandateLib.quoteExactIn(m, reserveA, reserveB, amountIn);
        assert(out * E18 >= amountIn * minRate);
    }
}
