// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { BatasApp } from "../src/BatasApp.sol";
import { Mandate, MandateLib } from "../src/Mandate.sol";
import { IBatasCallback } from "../src/IBatasCallback.sol";
import { TransientLockLib } from "@1inch/solidity-utils/contracts/libraries/TransientLock.sol";

/// @dev The test contract is the taker: it receives the callback and pays for the swap there.
contract BatasAppTest is Test, IBatasCallback {
    using MandateLib for Mandate;

    Aqua internal aqua;
    BatasApp internal app;
    TokenMock internal tokenIn;
    TokenMock internal tokenOut;

    address internal maker = makeAddr("maker");
    address internal agent = makeAddr("agent");

    uint256 internal constant RESERVE_IN = 1_000e18;
    uint256 internal constant RESERVE_OUT = 2_000e18;

    function setUp() public {
        aqua = new Aqua();
        app = new BatasApp(IAqua(address(aqua)));

        tokenIn = new TokenMock("In", "IN");
        tokenOut = new TokenMock("Out", "OUT");

        tokenIn.mint(maker, RESERVE_IN);
        tokenOut.mint(maker, RESERVE_OUT);
        vm.startPrank(maker);
        tokenIn.approve(address(aqua), type(uint256).max);
        tokenOut.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        // The taker (this contract) pays through Aqua.push, which pulls from msg.sender.
        tokenIn.approve(address(aqua), type(uint256).max);
    }

    /// @dev Ships the maker's liquidity under `m`. The encoded mandate *is* the Aqua strategy.
    function _ship(Mandate memory m) internal returns (bytes32 mandateHash) {
        address[] memory tokens = new address[](2);
        tokens[0] = m.tokenIn;
        tokens[1] = m.tokenOut;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE_IN;
        amounts[1] = RESERVE_OUT;

        vm.prank(maker);
        mandateHash = aqua.ship(address(app), m.encode(), tokens, amounts);
        assertEq(mandateHash, m.hash(), "mandate hash must equal Aqua strategy hash");
    }

    function _mandate() internal view returns (Mandate memory m) {
        m = Mandate({
            maker: maker,
            agent: agent,
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
            maxAmountIn: 100e18,
            minRateE18: 1.5e18,
            expiry: uint64(block.timestamp + 2 hours),
            feeBps: 0.003e7,
            salt: 0,
            nameRegistry: address(0),
            nameHolder: address(0),
            nameLabel: ""
        });
    }

    /// @dev When set, the callback tries to swap again against the same position before paying
    ///   for the first swap. Stored rather than passed so the re-entry uses the ordinary path.
    Mandate internal _reenterWith;
    bool internal _reenter;

    function batasSwapCallback(
        address tokenIn_,
        address,
        uint256 amountIn,
        uint256,
        address maker_,
        bytes32 mandateHash,
        bytes calldata
    ) external {
        if (_reenter) {
            _reenter = false;
            // Control is here because output has already left the maker's wallet and payment has
            // not been checked yet. That is the window the guard exists for.
            app.swap(_reenterWith, 1e18, 0, address(this), "");
        }
        TokenMock(tokenIn_).mint(address(this), amountIn);
        aqua.push(maker_, address(app), mandateHash, tokenIn_, amountIn);
    }

    /// @notice A swap inside every limit settles and moves real tokens.
    function test_SwapWithinMandate() public {
        Mandate memory m = _mandate();
        _ship(m);

        uint256 amountIn = 10e18;
        uint256 expected = app.quote(m, amountIn);

        uint256 takerOutBefore = tokenOut.balanceOf(address(this));
        uint256 makerInBefore = tokenIn.balanceOf(maker);
        uint256 makerOutBefore = tokenOut.balanceOf(maker);

        uint256 amountOut = app.swap(m, amountIn, 0, address(this), "");

        assertEq(amountOut, expected, "quote must match swap");
        assertEq(tokenOut.balanceOf(address(this)) - takerOutBefore, amountOut, "taker received output");

        // Aqua never takes custody: the reserves were virtual the whole time, and settlement is a
        // direct transfer in and out of the maker's own wallet.
        assertEq(tokenIn.balanceOf(maker) - makerInBefore, amountIn, "maker received input");
        assertEq(makerOutBefore - tokenOut.balanceOf(maker), amountOut, "maker paid output");
        assertEq(makerOutBefore, RESERVE_OUT, "maker held the full reserve in their own wallet");
    }

    /// @notice Past the expiry the mandate authorises nothing, however good the price is.
    function test_RevertWhenExpired() public {
        Mandate memory m = _mandate();
        _ship(m);

        // One second past, not the expiry second itself: that one is still inside the grant, and
        // both surfaces agree it is. See test_TheExpirySecondIsHonouredByBothSurfaces.
        vm.warp(uint256(m.expiry) + 1);
        vm.expectRevert(abi.encodeWithSelector(BatasApp.MandateExpired.selector, m.expiry, block.timestamp));
        app.swap(m, 10e18, 0, address(this), "");
    }

    /// @notice The agent field names who the grant went to; it gates nobody.
    /// @dev Worth pinning in both directions, because a field that is part of the hash and read by
    ///   nothing looks like an oversight until someone checks which it is. It is identity: the
    ///   same terms granted to a different operator are a different position, publicly readable
    ///   from Aqua's `Shipped` event. It is not permission: takers are whoever arrives, and a
    ///   position only its operator could trade against would not be liquidity at all.
    function test_TheAgentNamesTheGrantAndGatesNobody() public {
        Mandate memory m = _mandate();
        Mandate memory elsewhere = _mandate();
        elsewhere.agent = makeAddr("some other agent");
        assertTrue(m.hash() != elsewhere.hash(), "the operator must be part of the position's identity");

        _ship(m);

        assertTrue(address(this) != m.agent, "the taker in this test must not be the named agent");
        uint256 amountOut = app.swap(m, 10e18, 0, address(this), "");
        assertGt(amountOut, 0, "an ordinary taker must be able to trade against a mandated position");
    }

    /// @notice The size cap binds even though the pool could serve the trade.
    function test_RevertWhenOverCap() public {
        Mandate memory m = _mandate();
        _ship(m);

        uint256 tooBig = uint256(m.maxAmountIn) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(BatasApp.MandateAmountInExceeded.selector, tooBig, m.maxAmountIn)
        );
        app.swap(m, tooBig, 0, address(this), "");
    }

    /// @notice Slippage that breaches the floor price is refused by the mandate, not by the taker.
    function test_RevertWhenRateBelowFloor() public {
        Mandate memory m = _mandate();
        m.minRateE18 = 1.99e18; // pool starts at 2.0; any size at all moves it below this
        _ship(m);

        uint256 amountIn = 50e18;
        // Derived from the shared library rather than restated, so the test cannot drift from
        // the pricing the app and the compiled program both use.
        uint256 amountOut = MandateLib.quoteExactIn(m, RESERVE_IN, RESERVE_OUT, amountIn);
        vm.expectRevert(
            abi.encodeWithSelector(BatasApp.MandateRateTooLow.selector, amountOut, amountIn, m.minRateE18)
        );
        app.swap(m, amountIn, 0, address(this), "");
    }

    /// @notice quote() rejects for the same reasons swap() does, so an agent can test cheaply.
    function test_QuoteRejectsSameAsSwap() public {
        Mandate memory m = _mandate();
        _ship(m);

        vm.warp(uint256(m.expiry) + 1);
        vm.expectRevert(abi.encodeWithSelector(BatasApp.MandateExpired.selector, m.expiry, block.timestamp));
        app.quote(m, 10e18);
    }

    /// @notice Aqua refuses to reuse a strategy hash, so mandate terms cannot be quietly rewritten.
    function test_MandateTermsAreImmutable() public {
        Mandate memory m = _mandate();
        _ship(m);

        address[] memory tokens = new address[](2);
        tokens[0] = m.tokenIn;
        tokens[1] = m.tokenOut;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1e18;
        amounts[1] = 1e18;

        vm.prank(maker);
        vm.expectRevert();
        aqua.ship(address(app), m.encode(), tokens, amounts);
    }

    /// @notice The taker cannot swap again from inside its own callback.
    /// @dev This is the sharpest surface in the contract. `swap` sends the output, then hands
    ///   control to `msg.sender` before verifying that anything was paid for it — the same shape
    ///   as a flash swap. Without the lock a taker could re-enter against a position whose
    ///   reserves still read as untouched and drain the difference. The guard was there from the
    ///   start and nothing exercised it, which is the condition under which a guard keyed on the
    ///   wrong thing goes unnoticed.
    function test_RevertWhenTakerReentersTheSamePosition() public {
        Mandate memory m = _mandate();
        _ship(m);

        _reenterWith = m;
        _reenter = true;

        vm.expectRevert(TransientLockLib.UnexpectedLock.selector);
        app.swap(m, 10e18, 0, address(this), "");
    }

    /// @notice And the position is untouched afterwards: the whole swap reverted, not just the
    ///   inner one.
    function test_ReentrancyLeavesThePositionUnchanged() public {
        Mandate memory m = _mandate();
        _ship(m);

        uint256 makerOutBefore = tokenOut.balanceOf(maker);
        _reenterWith = m;
        _reenter = true;

        vm.expectRevert(TransientLockLib.UnexpectedLock.selector);
        app.swap(m, 10e18, 0, address(this), "");

        assertEq(tokenOut.balanceOf(maker), makerOutBefore, "no output may leave on a reverted swap");
        _reenter = false;
        assertGt(app.quote(m, 10e18), 0, "the position still prices trades normally afterwards");
    }

    /// @notice The taker's own slippage bound is honoured, separately from the maker's mandate.
    /// @dev The mandate protects the maker; `amountOutMin` protects the taker. Nothing asserted
    ///   this one, so a swap that silently ignored it would have looked correct.
    function test_RevertWhenBelowTakerMinimum() public {
        Mandate memory m = _mandate();
        _ship(m);

        uint256 amountIn = 10e18;
        uint256 expected = app.quote(m, amountIn);

        vm.expectRevert(
            abi.encodeWithSelector(BatasApp.InsufficientOutputAmount.selector, expected, expected + 1)
        );
        app.swap(m, amountIn, expected + 1, address(this), "");

        // And exactly the quoted amount is acceptable: the bound is a minimum, not a margin.
        assertEq(app.swap(m, amountIn, expected, address(this), ""), expected);
    }

    /// @notice An input too small to price is refused rather than settled for nothing.
    /// @dev Found by testFuzz_SurfacesAgreeOnArbitraryTerms at one wei, where a 0.3% fee rounds up
    ///   to the entire input and leaves the curve nothing to work with. The guard was added then;
    ///   this pins it by name, so removing it fails here rather than only as a disagreement
    ///   between two surfaces.
    function test_RevertWhenOutputRoundsToZero() public {
        Mandate memory m = _mandate();
        _ship(m);

        vm.expectRevert(abi.encodeWithSelector(BatasApp.ZeroAmountOut.selector, uint256(1)));
        app.swap(m, 1, 0, address(this), "");
    }

    /// @notice A zero input is refused before anything else is computed.
    function test_RevertWhenAmountInIsZero() public {
        Mandate memory m = _mandate();
        _ship(m);

        vm.expectRevert(BatasApp.ZeroAmountIn.selector);
        app.swap(m, 0, 0, address(this), "");
    }

    /// @notice Re-entering a *different* position of the same maker is allowed, and both settle
    ///   correctly.
    /// @dev The lock is keyed on (maker, strategyHash), so this is deliberately not blocked. Worth
    ///   pinning rather than assuming: a per-position lock is the kind of narrowing that looks like
    ///   an oversight, and the question a reviewer asks is whether the accounting survives it. Each
    ///   strategy carries its own Aqua balance, so the outer swap's payment check is measured
    ///   against a reserve the inner swap never touched.
    function test_ReentryIntoADifferentPositionIsSafe() public {
        Mandate memory outer = _mandate();
        _ship(outer);

        Mandate memory inner = _mandate();
        inner.salt = 1;
        // A second position needs a second set of tokens; the maker cannot ship the same ones twice.
        tokenIn.mint(maker, RESERVE_IN);
        tokenOut.mint(maker, RESERVE_OUT);
        _ship(inner);

        _reenterWith = inner;
        _reenter = true;

        uint256 amountIn = 10e18;
        uint256 expectedOuter = app.quote(outer, amountIn);
        uint256 expectedInner = app.quote(inner, 1e18);
        uint256 takerOutBefore = tokenOut.balanceOf(address(this));

        uint256 amountOut = app.swap(outer, amountIn, 0, address(this), "");

        assertEq(amountOut, expectedOuter, "the outer swap priced as quoted");
        assertEq(
            tokenOut.balanceOf(address(this)) - takerOutBefore,
            expectedOuter + expectedInner,
            "both swaps paid out, and neither was double counted"
        );
    }

    /// @notice Trading against the position repeatedly cannot walk it below its floor.
    /// @dev Every other test here settles one swap. The claim the project actually makes is about a
    ///   position an agent runs over time, and the cap bounds a single trade rather than a day's
    ///   volume — so the question a reader should ask is what stops someone taking the maximum
    ///   again and again until the reserves are drained at a price the maker never agreed to.
    ///
    ///   The floor does, and it does it without needing to know anything about volume. Each trade
    ///   is priced on the reserves as they stand, so the rate falls as the position is worked, and
    ///   the mandate refuses as soon as the next trade would breach the floor. What follows checks
    ///   both halves: every settled trade clears the floor on its own, and the cumulative rate
    ///   across all of them does too.
    function test_RepeatedTradingCannotWalkThePositionBelowItsFloor() public {
        Mandate memory m = _mandate();
        _ship(m);

        uint256 totalIn;
        uint256 totalOut;
        uint256 trades;
        uint256 lastRate = type(uint256).max;

        for (uint256 i = 0; i < 32; i++) {
            uint256 amountIn = m.maxAmountIn;
            try app.quote(m, amountIn) returns (uint256 quoted) {
                uint256 amountOut = app.swap(m, amountIn, 0, address(this), "");
                assertEq(amountOut, quoted, "quote and swap must agree at every point on the curve");

                uint256 rate = (amountOut * 1e18) / amountIn;
                assertGe(rate, m.minRateE18, "a settled trade below the floor is the failure this exists to prevent");
                assertLe(rate, lastRate, "working the position must make it dearer, never cheaper");
                lastRate = rate;

                totalIn += amountIn;
                totalOut += amountOut;
                trades++;
            } catch {
                break;
            }
        }

        assertGe(trades, 2, "this must exercise a sequence, not one trade and a refusal");
        assertLt(trades, 32, "and must refuse before the loop runs out, or nothing bounded it");
        assertGe(
            totalOut * 1e18,
            totalIn * uint256(m.minRateE18),
            "the average rate across every trade must clear the floor too"
        );
    }

    /// @notice And the position still holds real reserves when it stops.
    /// @dev The point of the floor is that it refuses while there is still something to protect.
    function test_ThePositionStopsWithReservesLeft() public {
        Mandate memory m = _mandate();
        _ship(m);

        for (uint256 i = 0; i < 32; i++) {
            try app.quote(m, m.maxAmountIn) returns (uint256) {
                app.swap(m, m.maxAmountIn, 0, address(this), "");
            } catch {
                break;
            }
        }

        // Whatever the maker has left is still theirs, in their own wallet, and it is not dust.
        assertGt(tokenOut.balanceOf(maker), RESERVE_OUT / 2, "the floor should stop the drain well before the reserve does");
    }
}
