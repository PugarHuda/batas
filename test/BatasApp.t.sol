// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { BatasApp } from "../src/BatasApp.sol";
import { Mandate, MandateLib } from "../src/Mandate.sol";
import { IBatasCallback } from "../src/IBatasCallback.sol";

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
            salt: 0
        });
    }

    function batasSwapCallback(
        address tokenIn_,
        address,
        uint256 amountIn,
        uint256,
        address maker_,
        bytes32 mandateHash,
        bytes calldata
    ) external {
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

        vm.warp(m.expiry);
        vm.expectRevert(abi.encodeWithSelector(BatasApp.MandateExpired.selector, m.expiry, block.timestamp));
        app.swap(m, 10e18, 0, address(this), "");
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

        vm.warp(m.expiry);
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
}
