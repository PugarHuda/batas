// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { BatasApp } from "../src/BatasApp.sol";
import { BatasRouter } from "../src/BatasRouter.sol";

/// @notice Deploys Batas against the canonical Aqua registry on Sepolia.
/// @dev Aqua is already live at the deterministic address below, so nothing about the liquidity
///   layer is re-deployed. Only our own app and the SwapVM router carrying PolicyEnvelope are,
///   which the 1inch track permits ("redeployments of a modified SwapVM contract is allowed").
contract Deploy is Script {
    /// @dev Same address on every chain Aqua is live on. Verified to hold code on Sepolia.
    address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;

    function run() external {
        uint256 pk = vm.envUint("SEPOLIA_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console.log("deployer", deployer);
        console.log("balance ", deployer.balance);
        require(AQUA.code.length > 0, "Aqua not deployed on this chain");

        vm.startBroadcast(pk);

        BatasApp app = new BatasApp(IAqua(AQUA));
        console.log("BatasApp", address(app));

        BatasRouter router = new BatasRouter(AQUA, address(0), deployer, "Batas", "1.0.0");
        console.log("BatasRouter", address(router));

        // Demo pair. Mintable so the walkthrough can be replayed without hunting for faucets.
        TokenMock tokenA = new TokenMock("Batas Demo USD", "aUSD");
        TokenMock tokenB = new TokenMock("Batas Demo ETH", "aETH");
        console.log("tokenA", address(tokenA));
        console.log("tokenB", address(tokenB));

        vm.stopBroadcast();
    }
}
