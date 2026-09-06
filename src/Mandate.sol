// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice A scoped, expiring grant of authority over a maker's liquidity.
/// @dev The encoded mandate *is* the Aqua strategy. `Aqua.ship()` hashes the strategy bytes,
///   so the mandate hash and the strategy hash are the same value: the terms are the identity
///   of the liquidity allocation, not metadata attached to it. Aqua rejects re-shipping a hash
///   that has already been used, which makes the terms immutable for the life of the position.
struct Mandate {
    address maker;
    address agent;
    address tokenIn;
    address tokenOut;
    /// @dev Largest input the maker will settle in a single swap.
    uint128 maxAmountIn;
    /// @dev Floor price: minimum amountOut per 1e18 of amountIn.
    uint128 minRateE18;
    /// @dev Unix timestamp after which the mandate no longer authorises anything.
    uint64 expiry;
    /// @dev Distinguishes otherwise identical mandates. Aqua permanently burns a strategy hash
    ///   on `dock()`, so renewing the same terms requires a fresh salt.
    bytes32 salt;
}

library MandateLib {
    /// @dev Must match what the maker passes to `Aqua.ship()` byte for byte.
    function encode(Mandate memory m) internal pure returns (bytes memory) {
        return abi.encode(m);
    }

    function hash(Mandate memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }
}
