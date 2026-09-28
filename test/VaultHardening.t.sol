// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {VaultBase} from "./AgentBudgetVault.t.sol";
import {AgentBudgetVault} from "../contracts/AgentBudgetVault.sol";
import {IAgentBudgetVault} from "../contracts/IAgentBudgetVault.sol";
import {DenyCodes} from "../contracts/DenyCodes.sol";

/// Hardening tests from the Phase 2 adversarial review (each pins a mutation that the first
/// suite let through, or a documented bound).
contract VaultHardeningTest is VaultBase {
    // ------------------------------------------------------------ constructor
    function test_constructorRejectsAgentEqualsFounder() public {
        vm.prank(founder);
        vm.expectRevert(bytes("bad config"));
        new AgentBudgetVault(address(usdc), founder, feeTo, 300, INF);
    }

    // ------------------------------------------------------------ RT-2 topUp fee-inclusive budget
    function test_RT2_topUpOverBudgetWithFee_boundary() public {
        vm.prank(founder);
        v.setMaxHold(type(uint256).max);
        uint256 id = _open(B, 1e6); // committed 1_030_000
        // leave exactly gross(2_560_000) = 2_636_800 free
        uint256 free = v.budget() - v.committed();
        vm.prank(founder);
        v.refund(free - 2_636_800, REC);
        assertEq(v.budget() - v.committed(), 2_636_800);
        // net 2_636_800 fits the free budget, its gross does not
        _deniedTopUp(id, 2_636_800, DenyCodes.OVER_BUDGET_WITH_FEE);
        // gross(2_560_001) = 2_636_801 -> +1 over
        _deniedTopUp(id, 2_560_001, DenyCodes.OVER_BUDGET_WITH_FEE);
        // committed + gross == budget passes
        vm.prank(agent);
        assertTrue(v.topUp(id, 2_560_000, REC));
        assertEq(v.committed(), v.budget());
    }

    // ------------------------------------------------------------ RT-3 settle / close priority
    function test_RT3_settlePriority_gateBeforeOverHold() public {
        uint256 id = _open(A, 1e6);
        uint256 tooMuch = 5e6; // > held
        vm.startPrank(founder);
        v.setPaused(true, REC);
        v.setVendor(A, false);
        vm.stopPrank();
        vm.warp(DL + 1);
        _deniedSettle(agent, id, tooMuch, DenyCodes.PAUSED);
        vm.prank(founder);
        v.setPaused(false, REC);
        _deniedSettle(agent, id, tooMuch, DenyCodes.PAST_DEADLINE);
        vm.warp(T0);
        _deniedSettle(agent, id, tooMuch, DenyCodes.VENDOR_NOT_ALLOWED);
        vm.prank(founder);
        v.setVendor(A, true);
        _deniedSettle(agent, id, tooMuch, DenyCodes.OVER_HOLD);
        // founder bypasses the gate but not OVER_HOLD
        vm.prank(founder);
        v.setPaused(true, REC);
        _deniedSettle(founder, id, tooMuch, DenyCodes.OVER_HOLD);
    }

    function test_RT3_closePriority_pausedBeforeDeadline() public {
        uint256 id = _open(B, 1e6);
        vm.prank(founder);
        v.setPaused(true, REC);
        vm.warp(DL + 1);
        _deniedClose(id, DenyCodes.PAUSED);
        vm.prank(founder);
        v.setPaused(false, REC);
        _deniedClose(id, DenyCodes.PAST_DEADLINE);
    }

    // ------------------------------------------------------------ RT-4 AUTH -> id -> closed -> PAUSED
    function test_RT4_authBeforeIdChecks() public {
        uint256 id = _open(B, 1e6);
        vm.prank(agent);
        v.close(id, REC);
        uint256[2] memory ids = [NO_JOB, id]; // unknown id, closed id
        for (uint256 i = 0; i < 2; i++) {
            vm.startPrank(attacker);
            vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
            v.topUp(ids[i], 1, REC);
            vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
            v.settle(ids[i], 1, REC);
            vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
            v.close(ids[i], REC);
            vm.stopPrank();
        }
    }

    function test_RT4_closedJobRevertsEvenWhenPausedAndPastDeadline() public {
        uint256 id = _open(B, 1e6);
        vm.prank(agent);
        v.close(id, REC);
        vm.prank(founder);
        v.setPaused(true, REC);
        vm.warp(DL + 1);
        vm.startPrank(agent);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.topUp(id, 1, REC);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.settle(id, 1, REC);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.close(id, REC);
        vm.stopPrank();
        vm.startPrank(founder);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.settle(id, 1, REC);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.close(id, REC);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ RT-5 founder paths move the money
    function _founderSettleAndClose(uint256 id) internal {
        uint256 b0 = usdc.balanceOf(B);
        uint256 f0 = usdc.balanceOf(feeTo);
        vm.prank(founder);
        assertTrue(v.settle(id, 500_000, REC));
        assertEq(usdc.balanceOf(B) - b0, 500_000, "vendor paid net");
        assertEq(usdc.balanceOf(feeTo) - f0, 15_000, "fee paid");
        IAgentBudgetVault.Job memory j = v.getJob(id);
        assertEq(j.paid, _gross(500_000));
        vm.recordLogs();
        vm.prank(founder);
        assertTrue(v.close(id, REC2));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(abi.decode(logs[0].data, (uint256)), j.held - j.paid, "released = held - paid");
        assertEq(v.committed(), j.paid, "only the paid gross stays committed");
    }

    function test_RT5_founderSettleAfterDeadlineMovesMoney() public {
        uint256 id = _open(B, 1e6);
        vm.warp(DL + 1 days);
        _founderSettleAndClose(id);
    }

    function test_RT5_founderSettleAfterPauseMovesMoney() public {
        uint256 id = _open(B, 1e6);
        vm.prank(founder);
        v.setPaused(true, REC);
        _founderSettleAndClose(id);
    }

    // ------------------------------------------------------------ RT-6 fund overwrites (also earlier)
    function test_RT6_fundOverwritesDeadlineEvenToEarlier() public {
        vm.startPrank(founder);
        usdc.approve(address(v), 2);
        v.fund(1, DL + 1 days);
        assertEq(v.deadline(), DL + 1 days);
        v.fund(1, T0 + 60);
        assertEq(v.deadline(), T0 + 60, "fund must overwrite, not only extend");
        vm.stopPrank();
    }

    // ------------------------------------------------------------ RT-7 recordDecision moves nothing
    function test_RT7_recordDecisionNoDelta() public {
        uint256 id = _open(B, 1e6);
        Snap memory s0 = _snap(B, id);
        vm.recordLogs();
        vm.prank(agent);
        v.recordDecision(id, DenyCodes.QWEN_DENIED, REC);
        _expectOnlyDenied(id, DenyCodes.QWEN_DENIED, REC, false);
        _assertNoDelta(s0, _snap(B, id));
        s0 = _snap(B, id);
        vm.recordLogs();
        vm.prank(founder);
        v.recordDecision(NO_JOB, DenyCodes.READ_FAILED, REC2);
        _expectOnlyDenied(NO_JOB, DenyCodes.READ_FAILED, REC2, false);
        _assertNoDelta(s0, _snap(B, id));
    }

    // ------------------------------------------------------------ RT-8 agent close ignores vendor status
    function test_RT8_agentCloseAllowedForDisabledVendor() public {
        uint256 id = _open(A, 1e6);
        vm.prank(founder);
        v.setVendor(A, false);
        vm.prank(agent);
        assertTrue(v.close(id, REC));
        assertEq(v.committed(), 0);
    }

    // ------------------------------------------------------------ RT-9 PausedSet carries rec
    function test_RT9_pausedSetCarriesIndexedRec() public {
        vm.recordLogs();
        vm.prank(founder);
        v.setPaused(true, REC);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(v));
        assertEq(logs[0].topics[0], IAgentBudgetVault.PausedSet.selector);
        assertEq(logs[0].topics[1], REC);
        assertTrue(abi.decode(logs[0].data, (bool)));
    }

    // ------------------------------------------------------------ event payloads the auditor replays
    function test_adminEventsCarryReplayPayloads() public {
        vm.startPrank(founder);
        usdc.approve(address(v), 5);
        vm.recordLogs();
        v.fund(5, DL + 7);
        Vm.Log[] memory l = vm.getRecordedLogs();
        Vm.Log memory funded = l[l.length - 1];
        assertEq(funded.topics[0], IAgentBudgetVault.Funded.selector);
        (uint256 amt, uint256 dl) = abi.decode(funded.data, (uint256, uint256));
        assertEq(amt, 5);
        assertEq(dl, DL + 7);
        vm.recordLogs();
        v.setVendor(C, false);
        l = vm.getRecordedLogs();
        assertEq(l.length, 1);
        assertEq(l[0].topics[0], IAgentBudgetVault.VendorSet.selector);
        assertEq(address(uint160(uint256(l[0].topics[1]))), C);
        assertFalse(abi.decode(l[0].data, (bool)));
        vm.recordLogs();
        v.setMaxHold(7e6);
        l = vm.getRecordedLogs();
        assertEq(l.length, 1);
        assertEq(l[0].topics[0], IAgentBudgetVault.MaxHoldSet.selector);
        assertEq(abi.decode(l[0].data, (uint256)), 7e6);
        vm.stopPrank();
        vm.recordLogs();
        vm.prank(agent);
        uint256 id = v.open(B, 1e6, REC);
        l = vm.getRecordedLogs();
        (uint256 net, uint256 gross) = abi.decode(l[0].data, (uint256, uint256));
        assertEq(net, 1e6);
        assertEq(gross, 1_030_000);
        vm.recordLogs();
        vm.prank(agent);
        v.topUp(id, 2e6, REC);
        l = vm.getRecordedLogs();
        (net, gross) = abi.decode(l[0].data, (uint256, uint256));
        assertEq(net, 2e6);
        assertEq(gross, 2_060_000);
    }

    // ------------------------------------------------------------ ML-1 documented stolen-agent-key bound
    /// With ONLY the agent key, an attacker can pay allow-listed vendors (+ fee) up to the vault
    /// balance = budget - sum(paid) = (budget - committed) + remaining open holds. maxHold caps each
    /// open/topUp reservation, not a settle: one settle can pay a job's whole remaining hold.
    /// Money never reaches a non-allow-listed address, and refund/setVendor stay founder-only.
    function test_ML1_stolenAgentKeyWorstCaseIsVaultBalanceToAllowedVendorsOnly() public {
        _open(B, 6e6); // honest backend reserved a hold
        uint256 vaultBal0 = usdc.balanceOf(address(v));
        vm.startPrank(agent);
        v.settle(0, 6e6, REC); // drains the honest hold to B
        uint256 id = v.open(C, 6e6, REC);
        for (uint256 i = 0; i < 14; i++) {
            v.topUp(id, 6e6, REC);
        }
        uint256 avail = v.getJob(id).held - v.getJob(id).paid;
        uint256 net = (avail * 10_000) / 10_300;
        while (net + (net * 300) / 10_000 > avail) net--;
        assertTrue(v.settle(id, net, REC));
        assertGt(net, MAXHOLD * 10, "one settle can exceed maxHold many times");
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.refund(1, REC);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.setVendor(attacker, true);
        vm.stopPrank();
        uint256 out = vaultBal0 - usdc.balanceOf(address(v));
        assertLe(out, vaultBal0, "bounded by the vault balance");
        assertEq(usdc.balanceOf(attacker), 0, "nothing reached a non-allow-listed address");
        assertEq(out, usdc.balanceOf(B) + usdc.balanceOf(C) + usdc.balanceOf(feeTo), "outflow went only to B, C, feeTo");
    }
}
