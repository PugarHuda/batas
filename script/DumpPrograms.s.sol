// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";

import { Mandate, MandateLib } from "../src/Mandate.sol";

/// @notice Prints the bytes `MandateLib.toProgram` produces for a fixed set of mandates.
/// @dev The agent builds SwapVM programs in JavaScript; the contracts build them in Solidity. Two
///   encoders for one format is a place where a divergence hides quietly: the agent would ship
///   programs the project's own compiler would never emit, and nothing on chain would object
///   because a program is just bytes. `agent/encoder-parity.test.mjs` runs this script and asserts
///   the JavaScript encoder produces the same bytes, case by case.
contract DumpPrograms is Script {
    using MandateLib for Mandate;

    address internal constant REGISTRY = 0x945800Bd6CDd60521B64a12D7b3F12fC90916a6B;
    address internal constant HOLDER = 0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E;

    function run() external pure {
        _dump("basic", 101e18, 1.92143732923348277e18, 1788698356, 0.003e7, 1788698356, address(0), address(0), "");
        _dump("zero-fee", 1e18, 1e18, 1, 0, 0, address(0), address(0), "");
        _dump("max-cap", type(uint128).max, 0, 4294967295, 0.05e7, 18446744073709551615, address(0), address(0), "");
        _dump("tight-floor", 500e18, 2.5e18, 2000000000, 0.0001e7, 7, address(0), address(0), "");
        // And the kill switch, which is where a second encoder is most likely to drift: the label
        // is variable-length, so the two have to agree about the length byte as well as the bytes.
        _dump("with-name", 101e18, 1.9e18, 1788698356, 0.003e7, 42, REGISTRY, HOLDER, "agent");
        _dump("long-label", 1e18, 1e18, 1788698356, 0, 1, REGISTRY, HOLDER, "an-unusually-long-mandate-label");
    }

    function _dump(
        string memory label,
        uint128 maxAmountIn,
        uint128 minRateE18,
        uint64 expiry,
        uint24 feeBps,
        uint64 salt,
        address nameRegistry,
        address nameHolder,
        string memory nameLabel
    ) internal pure {
        Mandate memory m = Mandate({
            maker: address(0xBEEF),
            agent: address(0xCAFE),
            tokenIn: address(0x1111),
            tokenOut: address(0x2222),
            maxAmountIn: maxAmountIn,
            minRateE18: minRateE18,
            expiry: expiry,
            feeBps: feeBps,
            salt: salt,
            nameRegistry: nameRegistry,
            nameHolder: nameHolder,
            nameLabel: nameLabel
        });
        console.log(
            string.concat(
                "CASE ",
                label,
                " ",
                vm.toString(maxAmountIn),
                " ",
                vm.toString(minRateE18),
                " ",
                vm.toString(expiry),
                " ",
                vm.toString(feeBps),
                " ",
                vm.toString(salt),
                " ",
                vm.toString(nameRegistry),
                " ",
                vm.toString(nameHolder),
                " ",
                bytes(nameLabel).length == 0 ? "-" : nameLabel,
                " ",
                vm.toString(m.toProgram())
            )
        );
    }
}
