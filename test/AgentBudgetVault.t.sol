// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {AgentBudgetVault} from "../contracts/AgentBudgetVault.sol";
import {IAgentBudgetVault} from "../contracts/IAgentBudgetVault.sol";
import {MockUSDC} from "../contracts/MockUSDC.sol";
import {DenyCodes} from "../contracts/DenyCodes.sol";

/// Base fixture: founder = deployer, agent hot key, vendors A/B/C + INFERENCE, feeTo, maxHold $6.
contract VaultBase is Test {
    MockUSDC internal usdc;
    AgentBudgetVault internal v;

    address internal founder = makeAddr("founder");
    address internal agent = makeAddr("agent");
    address internal feeTo = makeAddr("feeTo");
    address internal INF = makeAddr("inference");
    address internal A = makeAddr("vendorA");
    address internal B = makeAddr("vendorB");
    address internal C = makeAddr("vendorC");
    address internal BAD = address(0xBAd0000000000000000000000000000000000Bad);
    address internal attacker = makeAddr("attacker");

    uint256 internal constant NO_JOB = type(uint256).max;
    uint256 internal constant BUDGET = 100e6;
    uint256 internal constant MAXHOLD = 6e6;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal DL;

    bytes32 internal constant REC = keccak256("rec");
    bytes32 internal constant REC2 = keccak256("rec2");

    function setUp() public virtual {
        vm.warp(T0);
        DL = T0 + 2 hours;
        usdc = new MockUSDC();
        usdc.mint(founder, 1_000e6);
        vm.startPrank(founder);
        v = new AgentBudgetVault(address(usdc), agent, feeTo, 300, INF);
        usdc.approve(address(v), BUDGET);
        v.fund(BUDGET, DL);
        v.setVendor(A, true);
        v.setVendor(B, true);
        v.setVendor(C, true);
        v.setVendor(INF, true);
        v.setMaxHold(MAXHOLD);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers
    struct Snap {
        uint256 vaultBal;
        uint256 founderBal;
        uint256 vendorBal;
        uint256 feeToBal;
        uint256 budget;
        uint256 committed;
        uint256 jobs;
        uint256 held;
        uint256 paid;
    }

    function _snap(address vendor, uint256 jobId) internal view returns (Snap memory s) {
        s.vaultBal = usdc.balanceOf(address(v));
        s.founderBal = usdc.balanceOf(founder);
        s.vendorBal = usdc.balanceOf(vendor);
        s.feeToBal = usdc.balanceOf(feeTo);
        s.budget = v.budget();
        s.committed = v.committed();
        s.jobs = v.jobCount();
        if (jobId < s.jobs) {
            IAgentBudgetVault.Job memory j = v.getJob(jobId);
            s.held = j.held;
            s.paid = j.paid;
        }
    }

    function _assertNoDelta(Snap memory a, Snap memory b) internal pure {
        assertEq(a.vaultBal, b.vaultBal, "vault balance moved");
        assertEq(a.founderBal, b.founderBal, "founder balance moved");
        assertEq(a.vendorBal, b.vendorBal, "vendor balance moved");
        assertEq(a.feeToBal, b.feeToBal, "feeTo balance moved");
        assertEq(a.budget, b.budget, "budget changed");
        assertEq(a.committed, b.committed, "committed changed");
        assertEq(a.jobs, b.jobs, "jobs.length changed (ghost job)");
        assertEq(a.held, b.held, "held changed");
        assertEq(a.paid, b.paid, "paid changed");
    }

    /// exactly one log, and it is Denied(jobId, code, rec, enforced) from the vault
    function _expectOnlyDenied(uint256 jobId, bytes32 code, bytes32 rec, bool enforced) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "expected exactly one log");
        assertEq(logs[0].emitter, address(v));
        assertEq(logs[0].topics.length, 4);
        assertEq(logs[0].topics[0], IAgentBudgetVault.Denied.selector);
        assertEq(uint256(logs[0].topics[1]), jobId, "jobId");
        assertEq(logs[0].topics[2], code, "code");
        assertEq(logs[0].topics[3], rec, "rec");
        assertEq(abi.decode(logs[0].data, (bool)), enforced, "enforced");
    }

    function _open(address vendor, uint256 net) internal returns (uint256 id) {
        vm.prank(agent);
        id = v.open(vendor, net, REC);
        assertTrue(id != NO_JOB, "open denied");
    }

    /// open that must be Denied with `code`, moving nothing and creating no job
    function _deniedOpen(address vendor, uint256 net, bytes32 code) internal {
        Snap memory s0 = _snap(vendor, NO_JOB);
        vm.recordLogs();
        vm.prank(agent);
        uint256 id = v.open(vendor, net, REC);
        assertEq(id, NO_JOB, "must return NO_JOB");
        _expectOnlyDenied(NO_JOB, code, REC, true);
        _assertNoDelta(s0, _snap(vendor, NO_JOB));
    }

    function _deniedTopUp(uint256 id, uint256 net, bytes32 code) internal {
        address vendor = v.getJob(id).vendor;
        Snap memory s0 = _snap(vendor, id);
        vm.recordLogs();
        vm.prank(agent);
        assertFalse(v.topUp(id, net, REC2));
        _expectOnlyDenied(id, code, REC2, true);
        _assertNoDelta(s0, _snap(vendor, id));
    }

    function _deniedSettle(address who, uint256 id, uint256 net, bytes32 code) internal {
        address vendor = v.getJob(id).vendor;
        Snap memory s0 = _snap(vendor, id);
        vm.recordLogs();
        vm.prank(who);
        assertFalse(v.settle(id, net, REC2));
        _expectOnlyDenied(id, code, REC2, true);
        _assertNoDelta(s0, _snap(vendor, id));
    }

    function _deniedClose(uint256 id, bytes32 code) internal {
        address vendor = v.getJob(id).vendor;
        Snap memory s0 = _snap(vendor, id);
        vm.recordLogs();
        vm.prank(agent);
        assertFalse(v.close(id, REC2));
        _expectOnlyDenied(id, code, REC2, true);
        _assertNoDelta(s0, _snap(vendor, id));
        assertFalse(v.getJob(id).closed);
    }

    function _gross(uint256 net) internal pure returns (uint256) {
        return net + (net * 300) / 10_000;
    }
}

contract VaultTest is VaultBase {
    // ================================================================== C1 config + permissions
    function test_C1_constructorAndRoles() public view {
        assertEq(v.founder(), founder);
        assertEq(v.agent(), agent);
        assertEq(v.feeTo(), feeTo);
        assertEq(v.feeBps(), 300);
        assertEq(v.inferencePayee(), INF);
        assertEq(v.usdc(), address(usdc));
        assertEq(v.budget(), BUDGET);
        assertEq(v.committed(), 0);
        assertEq(v.deadline(), DL);
        assertEq(v.maxHold(), MAXHOLD);
        assertTrue(v.vendorAllowed(B));
        assertFalse(v.vendorAllowed(BAD));
        assertEq(v.NO_JOB(), NO_JOB);
    }

    function test_C1_fundTwiceOverwritesDeadline() public {
        vm.startPrank(founder);
        usdc.approve(address(v), 10e6);
        v.fund(10e6, DL + 1 days);
        vm.stopPrank();
        assertEq(v.budget(), BUDGET + 10e6);
        assertEq(v.deadline(), DL + 1 days, "fund must overwrite the deadline");
    }

    function test_C1_founderOnlyFunctionsRevertForOthers() public {
        address[2] memory who = [agent, attacker];
        for (uint256 i = 0; i < 2; i++) {
            vm.startPrank(who[i]);
            vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
            v.fund(1, DL);
            vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
            v.setVendor(BAD, true);
            vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
            v.setMaxHold(1e18);
            vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
            v.setPaused(true, REC);
            vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
            v.refund(1, REC);
            vm.stopPrank();
        }
    }

    function test_unauthorizedAgentFunctionsRevert() public {
        uint256 id = _open(B, 1e6);
        vm.startPrank(attacker);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.open(B, 1e6, REC);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.topUp(id, 1e6, REC);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.settle(id, 1, REC);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.close(id, REC);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.recordDecision(NO_JOB, DenyCodes.QWEN_DENIED, REC);
        vm.stopPrank();
        // founder may not open/topUp (agent-only)
        vm.startPrank(founder);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.open(B, 1e6, REC);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.topUp(id, 1e6, REC);
        vm.stopPrank();
    }

    // ================================================================== normal flow (C-normal)
    function test_normalFlow_fund_open_settle_topUp_settle_close_refund() public {
        uint256 net = 2_560_000; // 1 sim hour at vendor B's $2.56/h
        uint256 g = _gross(net); // 2_636_800
        vm.recordLogs();
        vm.prank(agent);
        uint256 id = v.open(B, net, REC);
        assertEq(id, 0);
        assertEq(v.committed(), g);
        assertEq(v.getJob(id).held, g);

        // checkpoint settle 1.28 net
        vm.prank(agent);
        assertTrue(v.settle(id, 1_280_000, REC));
        assertEq(usdc.balanceOf(B), 1_280_000);
        assertEq(usdc.balanceOf(feeTo), 38_400);

        // top-up 2.56 net
        vm.prank(agent);
        assertTrue(v.topUp(id, net, REC));
        assertEq(v.getJob(id).held, 2 * g);
        assertEq(v.committed(), 2 * g);

        // settle 2.00 net
        vm.prank(agent);
        assertTrue(v.settle(id, 2_000_000, REC));
        uint256 paid = _gross(1_280_000) + _gross(2_000_000);
        assertEq(v.getJob(id).paid, paid);

        // close releases held - paid
        vm.recordLogs();
        vm.prank(agent);
        assertTrue(v.close(id, REC2));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], IAgentBudgetVault.Closed.selector);
        assertEq(logs[0].topics[2], REC2, "Closed carries rec (indexed)");
        assertEq(abi.decode(logs[0].data, (uint256)), 2 * g - paid);
        assertEq(v.committed(), paid);

        // refund exactly budget - committed == vault balance
        uint256 free = v.budget() - v.committed();
        assertEq(free, usdc.balanceOf(address(v)));
        uint256 f0 = usdc.balanceOf(founder);
        vm.prank(founder);
        v.refund(free, REC2);
        assertEq(usdc.balanceOf(founder) - f0, free);
        assertEq(usdc.balanceOf(address(v)), 0);
        assertEq(v.budget(), v.committed());
    }

    // ================================================================== C2 open Denied
    function test_C2_deniedVendor() public {
        _deniedOpen(BAD, 1e6, DenyCodes.VENDOR_NOT_ALLOWED);
    }

    function test_C2_deniedBudgetWithFee() public {
        // net fits the free budget, gross does not
        vm.prank(founder);
        v.setMaxHold(type(uint256).max);
        _deniedOpen(B, BUDGET, DenyCodes.OVER_BUDGET_WITH_FEE);
    }

    function test_C2_deniedMaxHold() public {
        _deniedOpen(B, MAXHOLD + 1, DenyCodes.OVER_MAX_HOLD);
    }

    function test_C2_deniedDeadline() public {
        vm.warp(DL);
        _deniedOpen(B, 1e6, DenyCodes.PAST_DEADLINE);
    }

    function test_C2_deniedPaused() public {
        vm.prank(founder);
        v.setPaused(true, REC);
        _deniedOpen(B, 1e6, DenyCodes.PAUSED);
    }

    function test_C2_boundaryMaxHold() public {
        _open(B, MAXHOLD); // == maxHold passes (gross 6.18 > 6 is fine: maxHold is NET)
        _deniedOpen(B, MAXHOLD + 1, DenyCodes.OVER_MAX_HOLD);
    }

    function test_C2_boundaryBudget() public {
        vm.prank(founder);
        v.setMaxHold(type(uint256).max);
        // largest net whose gross fits exactly: gross(97_087_378) = 99_999_999 ; gross(97_087_379) = 100_000_000
        uint256 net = 97_087_379;
        assertEq(v.grossOf(B, net), BUDGET);
        _deniedOpen(B, net + 1, DenyCodes.OVER_BUDGET_WITH_FEE);
        _open(B, net); // committed + gross == budget passes
        assertEq(v.committed(), BUDGET);
        _deniedOpen(B, 1, DenyCodes.OVER_BUDGET_WITH_FEE);
    }

    function test_C2_uint256MaxNoPanic() public {
        _deniedOpen(B, type(uint256).max, DenyCodes.OVER_MAX_HOLD);
        vm.prank(founder);
        v.setMaxHold(type(uint256).max);
        _deniedOpen(B, type(uint256).max, DenyCodes.OVER_BUDGET_WITH_FEE);
    }

    function test_C2_deniedOpenReturnsNoJobAndNoGhostJob() public {
        _deniedOpen(BAD, 1e6, DenyCodes.VENDOR_NOT_ALLOWED);
        assertEq(v.jobCount(), 0);
        uint256 id = _open(B, 1e6);
        assertEq(id, 0, "first real job is id 0: the denied open created nothing");
    }

    // ================================================================== C13 multi-violation priority
    function test_C13_multiViolationPriority() public {
        vm.prank(founder);
        v.setPaused(true, REC);
        vm.warp(DL + 1);
        // paused + past deadline + disallowed vendor + over maxHold + over budget -> PAUSED
        _deniedOpen(BAD, type(uint256).max, DenyCodes.PAUSED);
        vm.prank(founder);
        v.setPaused(false, REC);
        _deniedOpen(BAD, type(uint256).max, DenyCodes.PAST_DEADLINE);
        vm.warp(T0);
        _deniedOpen(BAD, type(uint256).max, DenyCodes.VENDOR_NOT_ALLOWED);
        _deniedOpen(B, type(uint256).max, DenyCodes.OVER_MAX_HOLD);
    }

    // ================================================================== C3 topUp
    function test_C3_topUpDisabledVendorDenied() public {
        uint256 id = _open(A, 1e6);
        vm.prank(founder);
        v.setVendor(A, false);
        _deniedTopUp(id, 1e6, DenyCodes.VENDOR_NOT_ALLOWED);
    }

    function test_C3_topUpDeniedCodes() public {
        uint256 id = _open(B, 1e6);
        _deniedTopUp(id, MAXHOLD + 1, DenyCodes.OVER_MAX_HOLD);
        vm.prank(founder);
        v.setPaused(true, REC);
        _deniedTopUp(id, 1e6, DenyCodes.PAUSED);
        vm.prank(founder);
        v.setPaused(false, REC);
        vm.warp(DL);
        _deniedTopUp(id, 1e6, DenyCodes.PAST_DEADLINE);
    }

    function test_C3_topUpUnknownIdRevertsJobClosed() public {
        vm.prank(agent);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.topUp(0, 1e6, REC);
        vm.prank(agent);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.topUp(NO_JOB, 1e6, REC);
    }

    // ================================================================== C4 settle
    function test_C4_feeFloor() public {
        uint256 id = _open(B, 1e6);
        vm.prank(agent);
        v.settle(id, 33, REC);
        assertEq(usdc.balanceOf(feeTo), 0);
        vm.prank(agent);
        v.settle(id, 34, REC);
        assertEq(usdc.balanceOf(feeTo), 1);
        assertEq(usdc.balanceOf(B), 67);
    }

    function test_C4_settleExactlyHeldOkPlusOneDenied() public {
        uint256 id = _open(B, 2_560_000); // held 2_636_800 gross
        _deniedSettle(agent, id, 2_560_001, DenyCodes.OVER_HOLD); // gross 2_636_801 > held
        vm.prank(agent);
        assertTrue(v.settle(id, 2_560_000, REC)); // gross == held
        assertEq(v.getJob(id).paid, v.getJob(id).held);
        _deniedSettle(agent, id, 1, DenyCodes.OVER_HOLD);
    }

    function test_C4_holdOverSettleHugeNetNoPanic() public {
        uint256 id = _open(B, 1e6);
        _deniedSettle(agent, id, type(uint256).max, DenyCodes.OVER_HOLD);
        _deniedSettle(founder, id, type(uint256).max, DenyCodes.OVER_HOLD);
    }

    function test_C4_agentSettleDeniedWhenPausedOrPastDeadline() public {
        uint256 id = _open(B, 1e6);
        vm.prank(founder);
        v.setPaused(true, REC);
        _deniedSettle(agent, id, 1000, DenyCodes.PAUSED);
        vm.prank(founder);
        v.setPaused(false, REC);
        vm.warp(DL);
        _deniedSettle(agent, id, 1000, DenyCodes.PAST_DEADLINE);
    }

    /// D3: agent settle re-checks vendorAllowed[j.vendor]; founder bypasses
    function test_C4_D3_disabledVendorSettle() public {
        uint256 id = _open(A, 1e6);
        vm.prank(founder);
        v.setVendor(A, false);
        _deniedSettle(agent, id, 1000, DenyCodes.VENDOR_NOT_ALLOWED);
        vm.prank(founder);
        assertTrue(v.settle(id, 1000, REC));
        assertEq(usdc.balanceOf(A), 1000);
    }

    function test_C4_partialAgentSettleThenFounderDelta() public {
        uint256 id = _open(B, 2_560_000);
        vm.prank(agent);
        v.settle(id, 1_000_000, REC);
        vm.prank(founder);
        v.setPaused(true, REC);
        vm.prank(founder);
        assertTrue(v.settle(id, 500_000, REC)); // delta after pause
        assertEq(usdc.balanceOf(B), 1_500_000);
        assertEq(v.getJob(id).paid, _gross(1_000_000) + _gross(500_000));
    }

    // ================================================================== C5 founder paths
    function test_C5_founderSettleAfterPause() public {
        uint256 id = _open(B, 1e6);
        vm.prank(founder);
        v.setPaused(true, REC);
        vm.prank(founder);
        assertTrue(v.settle(id, 500_000, REC));
        vm.prank(founder);
        assertTrue(v.close(id, REC));
    }

    function test_C5_founderSettleAfterDeadline() public {
        uint256 id = _open(B, 1e6);
        vm.warp(DL + 1 days);
        vm.prank(founder);
        assertTrue(v.settle(id, 500_000, REC));
        vm.prank(founder);
        assertTrue(v.close(id, REC));
    }

    function test_C5_deadlineBoundary() public {
        uint256 id = _open(B, 1e6);
        vm.warp(DL - 1);
        vm.prank(agent);
        assertTrue(v.settle(id, 1000, REC)); // ts == deadline - 1 OK
        vm.warp(DL);
        _deniedSettle(agent, id, 1000, DenyCodes.PAST_DEADLINE); // ts == deadline Denied
    }

    // ================================================================== C6 close
    function test_C6_closeTwiceReverts() public {
        uint256 id = _open(B, 1e6);
        vm.prank(agent);
        v.close(id, REC);
        vm.prank(agent);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.close(id, REC);
        vm.prank(founder);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.close(id, REC);
    }

    function test_C6_closedJobRevertsForSettleAndTopUp() public {
        uint256 id = _open(B, 1e6);
        vm.prank(agent);
        v.close(id, REC);
        vm.prank(agent);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.settle(id, 1, REC);
        vm.prank(founder);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.settle(id, 1, REC);
        vm.prank(agent);
        vm.expectRevert(IAgentBudgetVault.JobClosed.selector);
        v.topUp(id, 1, REC);
    }

    /// D3: agent close after pause is Denied(PAUSED), founder close OK
    function test_C6_D3_agentCloseAfterPause() public {
        uint256 id = _open(B, 1e6);
        vm.prank(founder);
        v.setPaused(true, REC);
        _deniedClose(id, DenyCodes.PAUSED);
        vm.prank(founder);
        assertTrue(v.close(id, REC));
        assertEq(v.committed(), 0);
    }

    /// D3: agent close after deadline is Denied(PAST_DEADLINE), founder close OK
    function test_C6_D3_agentCloseAfterDeadline() public {
        uint256 id = _open(B, 1e6);
        vm.warp(DL);
        _deniedClose(id, DenyCodes.PAST_DEADLINE);
        vm.prank(founder);
        assertTrue(v.close(id, REC));
    }

    // ================================================================== C7 refund
    function test_C7_refundLimitWithOpenHold() public {
        uint256 id = _open(B, 5e6);
        uint256 free = BUDGET - _gross(5e6);
        vm.prank(founder);
        vm.expectRevert(IAgentBudgetVault.OverBudget.selector);
        v.refund(free + 1, REC);
        vm.prank(founder);
        v.refund(free, REC);
        assertEq(v.budget(), v.committed());
        // the open hold is still fully backed
        assertEq(usdc.balanceOf(address(v)), v.getJob(id).held);
    }

    function test_C7_refundAfterAllClosedEqualsBalance_andRefundedCarriesRec() public {
        uint256 id = _open(B, 3e6);
        vm.prank(agent);
        v.settle(id, 1e6, REC);
        vm.prank(agent);
        v.close(id, REC);
        uint256 free = v.budget() - v.committed();
        assertEq(free, usdc.balanceOf(address(v)));
        vm.recordLogs();
        vm.prank(founder);
        v.refund(free, REC2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // MockUSDC Transfer + Refunded
        Vm.Log memory r = logs[logs.length - 1];
        assertEq(r.emitter, address(v));
        assertEq(r.topics[0], IAgentBudgetVault.Refunded.selector);
        assertEq(r.topics[1], REC2);
        assertEq(abi.decode(r.data, (uint256)), free);
        assertEq(usdc.balanceOf(address(v)), 0);
    }

    function test_C7_refundZeroAnchorsRec() public {
        vm.startPrank(founder);
        v.refund(BUDGET, REC);
        v.refund(0, REC2); // session-end anchor even with nothing left
        vm.stopPrank();
    }

    // ================================================================== C8 recordDecision
    function test_C8_recordDecisionNoJob() public {
        vm.recordLogs();
        vm.prank(agent);
        v.recordDecision(NO_JOB, DenyCodes.QWEN_DENIED, REC);
        _expectOnlyDenied(NO_JOB, DenyCodes.QWEN_DENIED, REC, false);
    }

    function test_C8_recordDecisionFounderAllowedThirdPartyReverts() public {
        vm.recordLogs();
        vm.prank(founder);
        v.recordDecision(7, DenyCodes.READ_FAILED, REC);
        _expectOnlyDenied(7, DenyCodes.READ_FAILED, REC, false);
        vm.prank(attacker);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.recordDecision(NO_JOB, DenyCodes.QWEN_DENIED, REC);
    }

    function test_C8_recordDecisionAllowedWhilePausedAndAfterDeadline() public {
        vm.prank(founder);
        v.setPaused(true, REC);
        vm.warp(DL + 1);
        vm.recordLogs();
        vm.prank(agent);
        v.recordDecision(NO_JOB, DenyCodes.TOPUP_TIMEOUT, REC);
        _expectOnlyDenied(NO_JOB, DenyCodes.TOPUP_TIMEOUT, REC, false);
    }

    // ================================================================== C9 INFERENCE fee exemption
    function test_C9_inferenceFeeZero() public {
        uint256 id = _open(INF, 50_000); // D2 fixed $0.05 hold
        assertEq(v.getJob(id).held, 50_000, "INFERENCE hold is gross == net");
        vm.prank(agent);
        assertTrue(v.settle(id, 8_400, REC));
        assertEq(usdc.balanceOf(INF), 8_400);
        assertEq(usdc.balanceOf(feeTo), 0);
        assertEq(v.grossOf(INF, 1e6), 1e6);
        assertEq(v.grossOf(B, 1e6), 1_030_000);
    }

    // ================================================================== C10 migration
    function test_C10_migration_settleA_closeA_disableA_openB() public {
        uint256 a = _open(A, 2e6);
        vm.prank(agent);
        v.settle(a, 1e6, REC);
        vm.prank(agent);
        v.close(a, REC);
        vm.prank(founder);
        v.setVendor(A, false);
        _deniedOpen(A, 1e6, DenyCodes.VENDOR_NOT_ALLOWED);
        vm.prank(agent);
        uint256 b = v.open(B, 2e6, REC2);
        assertEq(b, 1);
        assertEq(v.committed(), _gross(1e6) + _gross(2e6));
    }

    // ================================================================== C12 cross-language
    function test_C12_vaultGrossMatchesFeeCases() public view {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/fixtures/fee-cases.json"));
        uint256[] memory net = vm.parseJsonUintArray(j, ".net");
        bool[] memory exempt = vm.parseJsonBoolArray(j, ".exempt");
        uint256[] memory gross_ = vm.parseJsonUintArray(j, ".gross");
        for (uint256 i = 0; i < net.length; i++) {
            assertEq(v.grossOf(exempt[i] ? INF : B, net[i]), gross_[i]);
        }
    }

    // ================================================================== C14 indexed topics
    function test_C14_recordHashIsIndexedOnSpendEvents() public {
        vm.recordLogs();
        vm.prank(agent);
        uint256 id = v.open(B, 1e6, REC);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], IAgentBudgetVault.HoldOpened.selector);
        assertEq(uint256(logs[0].topics[1]), id);
        assertEq(address(uint160(uint256(logs[0].topics[2]))), B);
        assertEq(logs[0].topics[3], REC);
        vm.recordLogs();
        vm.prank(agent);
        v.topUp(id, 1e6, REC2);
        logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], IAgentBudgetVault.ToppedUp.selector);
        assertEq(logs[0].topics[2], REC2);
        vm.recordLogs();
        vm.prank(agent);
        v.settle(id, 1e6, REC);
        logs = vm.getRecordedLogs();
        Vm.Log memory s = logs[logs.length - 1];
        assertEq(s.topics[0], IAgentBudgetVault.Settled.selector);
        assertEq(s.topics[3], REC);
        (uint256 net, uint256 fee) = abi.decode(s.data, (uint256, uint256));
        assertEq(net, 1e6);
        assertEq(fee, 30_000);
    }

    // ================================================================== stolen agent key (C-attack)
    function test_stolenAgentKey_allRuleViolationsDeniedNoFundsMove() public {
        _deniedOpen(BAD, 1e6, DenyCodes.VENDOR_NOT_ALLOWED);
        _deniedOpen(B, MAXHOLD + 1, DenyCodes.OVER_MAX_HOLD);
        vm.startPrank(agent);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.refund(1, REC);
        vm.expectRevert(IAgentBudgetVault.Unauthorized.selector);
        v.setVendor(BAD, true);
        vm.stopPrank();
    }
}

/// C11: invariant fuzz. balance == budget - sum(paid), committed <= budget,
/// committed == sum(open held) + sum(paid of all jobs).
contract Handler is Test {
    AgentBudgetVault internal v;
    MockUSDC internal usdc;
    address internal founder;
    address internal agent;
    address[] internal vendors;
    uint256 public totalPaid;

    constructor(AgentBudgetVault v_, MockUSDC u_, address f_, address a_, address[] memory vs) {
        v = v_;
        usdc = u_;
        founder = f_;
        agent = a_;
        vendors = vs;
    }

    function open(uint256 vi, uint256 net) external {
        vm.prank(agent);
        v.open(vendors[vi % vendors.length], bound(net, 0, 8e6), bytes32(0));
    }

    function topUp(uint256 id, uint256 net) external {
        uint256 n = v.jobCount();
        if (n == 0) return;
        id = id % n;
        if (v.getJob(id).closed) return;
        vm.prank(agent);
        v.topUp(id, bound(net, 0, 8e6), bytes32(0));
    }

    function settle(uint256 id, uint256 net, bool asFounder) external {
        uint256 n = v.jobCount();
        if (n == 0) return;
        id = id % n;
        if (v.getJob(id).closed) return;
        uint256 before = v.getJob(id).paid;
        vm.prank(asFounder ? founder : agent);
        v.settle(id, bound(net, 0, 7e6), bytes32(0));
        totalPaid += v.getJob(id).paid - before;
    }

    function close(uint256 id, bool asFounder) external {
        uint256 n = v.jobCount();
        if (n == 0) return;
        id = id % n;
        if (v.getJob(id).closed) return;
        vm.prank(asFounder ? founder : agent);
        v.close(id, bytes32(0));
    }

    function refund(uint256 amount) external {
        uint256 free = v.budget() - v.committed();
        vm.prank(founder);
        v.refund(bound(amount, 0, free), bytes32(0));
    }

    function pause(bool p) external {
        vm.prank(founder);
        v.setPaused(p, bytes32(0));
    }

    function toggleVendor(uint256 vi, bool allowed) external {
        vm.prank(founder);
        v.setVendor(vendors[vi % vendors.length], allowed);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 1 hours));
    }
}

contract VaultInvariantTest is VaultBase {
    Handler internal h;

    function setUp() public override {
        super.setUp();
        address[] memory vs = new address[](5);
        vs[0] = A;
        vs[1] = B;
        vs[2] = C;
        vs[3] = INF;
        vs[4] = BAD;
        h = new Handler(v, usdc, founder, agent, vs);
        targetContract(address(h));
    }

    function invariant_C11_balanceEqualsBudgetMinusPaid() public view {
        assertEq(usdc.balanceOf(address(v)), v.budget() - h.totalPaid());
    }

    function invariant_C11_committedWithinBudget() public view {
        assertLe(v.committed(), v.budget());
    }

    function invariant_C11_committedEqualsOpenHeldPlusPaid() public view {
        uint256 n = v.jobCount();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            IAgentBudgetVault.Job memory j = v.getJob(i);
            sum += j.closed ? j.paid : j.held;
            assertLe(j.paid, j.held);
        }
        assertEq(v.committed(), sum);
    }
}
