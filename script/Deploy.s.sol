// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {AgentBudgetVault} from "../contracts/AgentBudgetVault.sol";
import {MockUSDC} from "../contracts/MockUSDC.sol";

/// @notice make deploy / npm run deploy. One vault per recorded run (new agent key each time).
///   MockUSDC -> mint(founder, BUDGET) -> Vault(usdc, agent, feeTo, 300, inferencePayee)
///   -> approve(vault, BUDGET exactly) -> fund(BUDGET, VAULT_DEADLINE) -> setVendor(A,B,C,INFERENCE)
///   -> setMaxHold(MAX_HOLD). founder = the broadcasting account (forge --account founder).
/// Every value comes from env; VAULT_DEADLINE is required because fund() OVERWRITES the deadline.
contract Deploy is Script {
    function run() external {
        address agent = vm.envAddress("AGENT_ADDR");
        address feeTo = vm.envAddress("FEE_TO");
        address inferencePayee = vm.envAddress("INFERENCE_PAYEE");
        address vendorA = vm.envAddress("VENDOR_A");
        address vendorB = vm.envAddress("VENDOR_B");
        address vendorC = vm.envAddress("VENDOR_C");
        uint256 budget = vm.envUint("BUDGET_MICRO");
        uint256 deadline = vm.envUint("VAULT_DEADLINE");
        uint256 maxHold = vm.envUint("MAX_HOLD_MICRO");
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(300));

        vm.startBroadcast();
        address founder = msg.sender;
        MockUSDC usdc = new MockUSDC();
        usdc.mint(founder, budget);
        AgentBudgetVault vault = new AgentBudgetVault(address(usdc), agent, feeTo, feeBps, inferencePayee);
        usdc.approve(address(vault), budget);
        vault.fund(budget, deadline);
        vault.setVendor(vendorA, true);
        vault.setVendor(vendorB, true);
        vault.setVendor(vendorC, true);
        vault.setVendor(inferencePayee, true);
        vault.setMaxHold(maxHold);
        vm.stopBroadcast();
    }
}
