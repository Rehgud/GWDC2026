// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {AgentBudgetVault, IERC20} from "../contracts/AgentBudgetVault.sol";
import {MockUSDC} from "../contracts/MockUSDC.sol";

contract AgentBudgetVaultTest is Test {
    MockUSDC usdc;
    AgentBudgetVault vault;
    address founder = makeAddr("founder");
    address agent = makeAddr("agent");
    address feeTo = makeAddr("feeTo");
    address A = makeAddr("vendorA");
    address B = makeAddr("vendorB");
    address INF = makeAddr("inference");
    address stranger = makeAddr("stranger");

    uint256 constant BUDGET = 20e6; // $20
    uint256 constant MAX_HOLD = 6e6; // $6
    uint256 NO_JOB = type(uint256).max;
    uint64 deadline;
    bytes32 constant R = keccak256("rec");

    function setUp() public {
        usdc = new MockUSDC();
        vm.prank(founder);
        vault = new AgentBudgetVault(IERC20(address(usdc)), agent, feeTo, INF);
        usdc.mint(founder, 100e6);
        deadline = uint64(block.timestamp + 1 days);
        vm.startPrank(founder);
        usdc.approve(address(vault), BUDGET);
        vault.fund(BUDGET, deadline);
        vault.setVendor(A, true);
        vault.setVendor(B, true);
        vault.setVendor(INF, true);
        vault.setMaxHold(MAX_HOLD);
        vm.stopPrank();
    }

    // ---- helpers ----
    struct Snap { uint256 vault; uint256 a; uint256 b; uint256 fee; uint256 inf; uint256 budget; uint256 committed; uint256 jobs; uint256 held; uint256 paid; }

    function _snap() internal view returns (Snap memory s) {
        s = Snap(usdc.balanceOf(address(vault)), usdc.balanceOf(A), usdc.balanceOf(B), usdc.balanceOf(feeTo),
            usdc.balanceOf(INF), vault.budget(), vault.committed(), vault.jobCount(), 0, 0);
        for (uint256 i; i < s.jobs; i++) {
            (, uint256 h, uint256 p,) = vault.jobs(i);
            s.held += h;
            s.paid += p;
        }
    }

    /// Nothing moved, and exactly one enforced Denied(jobId, code) was logged since vm.recordLogs().
    function _assertDenied(uint256 jobId, bytes32 code, Snap memory before) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics[0], AgentBudgetVault.Denied.selector);
        assertEq(uint256(logs[0].topics[1]), jobId, "jobId");
        assertEq(logs[0].topics[2], code, "code");
        assertEq(logs[0].topics[3], R, "rec");
        assertTrue(abi.decode(logs[0].data, (bool)), "enforced");
        assertEq(keccak256(abi.encode(_snap())), keccak256(abi.encode(before)), "state changed");
    }

    function _open(address v, uint256 amt) internal returns (uint256 id) {
        vm.prank(agent);
        id = vault.open(v, amt, R);
        assertTrue(id != NO_JOB, "open denied");
    }

    function _openDenied(address v, uint256 amt, bytes32 code) internal {
        Snap memory s = _snap();
        vm.recordLogs();
        vm.prank(agent);
        assertEq(vault.open(v, amt, R), NO_JOB);
        _assertDenied(NO_JOB, code, s);
    }

    function _held(uint256 id) internal view returns (uint256 h) { (, h,,) = vault.jobs(id); }

    // ---- 1. happy path: fund -> open -> settle -> topUp -> settle -> close -> refund ----
    function test_happyPath() public {
        uint256 id = _open(A, 5e6); // gross 5.15
        assertEq(vault.committed(), 5.15e6);
        vm.prank(agent);
        assertTrue(vault.settle(id, 4e6, R)); // fee 0.12
        assertEq(usdc.balanceOf(A), 4e6);
        assertEq(usdc.balanceOf(feeTo), 0.12e6);
        vm.prank(agent);
        assertTrue(vault.topUp(id, 3e6, R)); // +3.09
        vm.prank(agent);
        assertTrue(vault.settle(id, 2e6, R)); // 2.06
        assertEq(_held(id), 5.15e6 - 4.12e6 + 3.09e6 - 2.06e6);
        vm.prank(agent);
        assertTrue(vault.close(id, R));
        assertEq(vault.committed(), 6.18e6); // only paid gross stays committed
        uint256 left = usdc.balanceOf(address(vault));
        assertEq(left, BUDGET - 6.18e6);
        vm.prank(founder);
        vault.refund(left, R);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(founder), 100e6 - 6.18e6);
    }

    // ---- 2. open Denied x5 + boundaries (C2) ----
    function test_openDenied_vendor() public { _openDenied(stranger, 1e6, "VENDOR_NOT_ALLOWED"); }

    function test_openDenied_maxHold_boundary() public {
        _openDenied(A, MAX_HOLD + 1, "OVER_MAX_HOLD");
        _open(A, MAX_HOLD);
    }

    function test_openDenied_uintMax_isMaxHoldNotPanic() public { _openDenied(A, type(uint256).max, "OVER_MAX_HOLD"); }

    function test_openDenied_budgetWithFee_boundary() public {
        _open(A, 6e6); // 6.18
        _open(A, 6e6); // 12.36
        _open(A, 6e6); // 18.54 -> 1.46 left
        _openDenied(A, 1.42e6, "OVER_BUDGET_WITH_FEE"); // gross 1.4626 > 1.46
        _open(A, 1.417476e6); // gross 1.417476 + 42524 = 1.46 exactly
        assertEq(vault.committed(), BUDGET);
    }

    function test_openDenied_deadline_boundary() public {
        vm.warp(deadline - 1);
        _open(A, 1e6);
        vm.warp(deadline);
        _openDenied(A, 1e6, "PAST_DEADLINE");
    }

    function test_openDenied_paused() public {
        vm.prank(founder);
        vault.setPaused(true, keccak256("stop"));
        _openDenied(A, 1e6, "PAUSED");
    }

    // C13: several violations at once -> first code in the fixed order
    function test_multiViolation_reportsPaused() public {
        vm.prank(founder);
        vault.setPaused(true, 0);
        vm.warp(deadline);
        _openDenied(stranger, type(uint256).max, "PAUSED");
    }

    // ---- C3 topUp ----
    function test_topUp_vendorDisallowed_denied() public {
        uint256 id = _open(A, 1e6);
        vm.prank(founder);
        vault.setVendor(A, false);
        Snap memory s = _snap();
        vm.recordLogs();
        vm.prank(agent);
        assertFalse(vault.topUp(id, 1e6, R));
        _assertDenied(id, "VENDOR_NOT_ALLOWED", s);
    }

    function test_topUp_maxHoldAppliesToo() public {
        uint256 id = _open(A, 1e6);
        Snap memory s = _snap();
        vm.recordLogs();
        vm.prank(agent);
        assertFalse(vault.topUp(id, MAX_HOLD + 1, R));
        _assertDenied(id, "OVER_MAX_HOLD", s);
    }

    // ---- 3. settle over hold (C4) ----
    function test_settle_overHold_boundary() public {
        uint256 id = _open(A, 1e6); // held 1.03
        Snap memory s = _snap();
        vm.recordLogs();
        vm.prank(agent);
        assertFalse(vault.settle(id, 1e6 + 1, R)); // gross 1030001 > 1030000
        _assertDenied(id, "OVER_HOLD", s);
        vm.prank(agent);
        assertTrue(vault.settle(id, 1e6, R)); // gross == held
        assertEq(_held(id), 0);
    }

    function test_settle_hugeAmount_isOverHoldNotPanic() public {
        uint256 id = _open(A, 1e6);
        Snap memory s = _snap();
        vm.recordLogs();
        vm.prank(founder);
        assertFalse(vault.settle(id, type(uint256).max, R));
        _assertDenied(id, "OVER_HOLD", s);
    }

    function test_settle_feeFloor() public {
        uint256 id = _open(A, 1e6);
        vm.startPrank(agent);
        vault.settle(id, 33, R);
        assertEq(usdc.balanceOf(feeTo), 0);
        vault.settle(id, 34, R);
        assertEq(usdc.balanceOf(feeTo), 1);
        vm.stopPrank();
    }

    // D3 guard 1: agent settle re-checks the allowlist; founder bypasses it
    function test_settle_agentRechecksAllowlist_founderBypasses() public {
        uint256 id = _open(A, 1e6);
        vm.prank(founder);
        vault.setVendor(A, false);
        Snap memory s = _snap();
        vm.recordLogs();
        vm.prank(agent);
        assertFalse(vault.settle(id, 5e5, R));
        _assertDenied(id, "VENDOR_NOT_ALLOWED", s);
        vm.prank(founder);
        assertTrue(vault.settle(id, 5e5, R));
        assertEq(usdc.balanceOf(A), 5e5);
    }

    // ---- 4. pause: agent settle/close Denied (D3 guard 2), founder settle/close OK (C6) ----
    function test_pause_agentDenied_founderSettlesAndCloses() public {
        uint256 id = _open(A, 2e6);
        vm.prank(agent);
        vault.settle(id, 5e5, R); // partial agent settle before STOP
        vm.prank(founder);
        vault.setPaused(true, keccak256("stop"));

        Snap memory s = _snap();
        vm.recordLogs();
        vm.prank(agent);
        assertFalse(vault.settle(id, 1e5, R));
        _assertDenied(id, "PAUSED", s);

        vm.recordLogs();
        vm.prank(agent);
        assertFalse(vault.close(id, R));
        _assertDenied(id, "PAUSED", s);

        vm.startPrank(founder);
        assertTrue(vault.settle(id, 1e6, R)); // founder settles the delta
        assertTrue(vault.close(id, R));
        vm.stopPrank();
        assertEq(usdc.balanceOf(A), 1.5e6);
        assertEq(vault.committed(), 1.545e6);
    }

    // ---- 5. deadline: agent Denied, founder path OK (C5) ----
    function test_deadline_agentDenied_founderPath() public {
        uint256 id = _open(A, 2e6);
        vm.warp(deadline);
        Snap memory s = _snap();
        vm.recordLogs();
        vm.prank(agent);
        assertFalse(vault.close(id, R));
        _assertDenied(id, "PAST_DEADLINE", s);

        vm.startPrank(founder);
        assertTrue(vault.settle(id, 1e6, R));
        assertTrue(vault.close(id, R));
        vault.refund(vault.budget() - vault.committed(), R);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // ---- 6. refund limit with an open hold (C7) ----
    function test_refund_limitedToUncommitted() public {
        _open(A, 5e6); // 5.15 committed
        uint256 left = BUDGET - 5.15e6;
        vm.startPrank(founder);
        vm.expectRevert(abi.encodeWithSelector(AgentBudgetVault.OverBudget.selector, left + 1, left));
        vault.refund(left + 1, R);
        vm.expectEmit(address(vault));
        emit AgentBudgetVault.Refunded(left, R);
        vault.refund(left, R);
        vm.stopPrank();
    }

    // ---- 7. recordDecision NO_JOB, enforced=false; stranger reverts (C8) ----
    function test_recordDecision() public {
        vm.expectEmit(address(vault));
        emit AgentBudgetVault.Denied(NO_JOB, "QWEN_DENIED", R, false);
        vm.prank(agent);
        vault.recordDecision(NO_JOB, "QWEN_DENIED", R);

        vm.prank(founder);
        vault.recordDecision(0, "PAUSED", R);

        vm.prank(stranger);
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.recordDecision(NO_JOB, "X", R);
    }

    // recordDecision stays allowed after pause/deadline
    function test_recordDecision_afterPauseAndDeadline() public {
        vm.prank(founder);
        vault.setPaused(true, 0);
        vm.warp(deadline + 1);
        vm.prank(agent);
        vault.recordDecision(NO_JOB, "QWEN_DENIED", R);
    }

    // ---- 8. INFERENCE is fee-exempt (C9) ----
    function test_inference_noFee() public {
        uint256 id = _open(INF, 0.05e6);
        assertEq(_held(id), 0.05e6);
        vm.prank(agent);
        vault.settle(id, 0.05e6, R);
        assertEq(usdc.balanceOf(INF), 0.05e6);
        assertEq(usdc.balanceOf(feeTo), 0);
    }

    // ---- 9. Unauthorized / JobClosed reverts ----
    function test_unauthorized() public {
        uint256 id = _open(A, 1e6);
        vm.startPrank(stranger);
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.open(A, 1, R);
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.topUp(id, 1, R);
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.settle(id, 1, R);
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.close(id, R);
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.setVendor(stranger, true);
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.refund(0, R);
        vm.stopPrank();

        vm.startPrank(founder); // founder cannot open/topUp
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.open(A, 1, R);
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.topUp(id, 1, R);
        vm.stopPrank();

        vm.prank(agent); // agent cannot refund / change the allowlist
        vm.expectRevert(AgentBudgetVault.Unauthorized.selector);
        vault.setVendor(stranger, true);
    }

    function test_jobClosed() public {
        uint256 id = _open(A, 1e6);
        vm.startPrank(agent);
        vm.expectRevert(AgentBudgetVault.JobClosed.selector);
        vault.settle(99, 1, R); // unknown id
        vault.close(id, R);
        vm.expectRevert(AgentBudgetVault.JobClosed.selector);
        vault.close(id, R);
        vm.expectRevert(AgentBudgetVault.JobClosed.selector);
        vault.settle(id, 1, R);
        vm.expectRevert(AgentBudgetVault.JobClosed.selector);
        vault.topUp(id, 1, R);
        vm.stopPrank();
    }

    // ---- 10. vendor migration: settle A -> close A -> setVendor(A,false) -> open B (C10) ----
    function test_migration() public {
        uint256 a = _open(A, 2e6);
        vm.startPrank(agent);
        vault.settle(a, 1e6, R);
        vault.close(a, R);
        vm.stopPrank();
        vm.prank(founder);
        vault.setVendor(A, false);
        _openDenied(A, 1e6, "VENDOR_NOT_ALLOWED");
        uint256 b = _open(B, 2e6);
        assertEq(b, 1);
        vm.prank(agent);
        vault.settle(b, 1e6, R);
        assertEq(usdc.balanceOf(B), 1e6);
    }

    // ---- C1: fund twice overwrites deadline (pinned behavior) ----
    function test_fundTwice_overwritesDeadline() public {
        vm.startPrank(founder);
        usdc.approve(address(vault), 1e6);
        vault.fund(1e6, 123);
        vm.stopPrank();
        assertEq(vault.deadline(), 123);
        assertEq(vault.budget(), BUDGET + 1e6);
    }

    // ---- C12: fee cases shared with rules.ts (test/fixtures/fee-cases.json) ----
    struct FeeCase { bool exempt; uint256 gross; uint256 net; } // alphabetical: vm.parseJson field order

    function test_feeCases_matchTs() public view {
        FeeCase[] memory cs = abi.decode(vm.parseJson(vm.readFile("test/fixtures/fee-cases.json")), (FeeCase[]));
        assertGt(cs.length, 5);
        for (uint256 i; i < cs.length; i++) {
            assertEq(vault.gross(cs[i].exempt ? INF : A, cs[i].net), cs[i].gross);
        }
    }

    // ---- C11: money invariants under random open/settle/close ----
    function testFuzz_invariants(uint256 o1, uint256 o2, uint256 s1, uint256 s2, bool closeFirst) public {
        o1 = bound(o1, 1, MAX_HOLD);
        o2 = bound(o2, 1, MAX_HOLD);
        uint256 a = _open(A, o1);
        vm.prank(agent);
        uint256 b = vault.open(INF, o2, R);
        vm.startPrank(agent);
        vault.settle(a, bound(s1, 0, o1), R);
        if (b != NO_JOB) vault.settle(b, bound(s2, 0, o2), R);
        if (closeFirst) vault.close(a, R);
        vm.stopPrank();

        Snap memory s = _snap();
        assertLe(s.committed, s.budget);
        assertEq(s.vault, s.budget - s.paid); // balance == budget - sum(paid)
        assertEq(s.committed, s.held + s.paid);
        assertEq(s.a + s.fee + s.inf, s.paid);
    }
}
