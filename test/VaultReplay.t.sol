// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {VaultBase} from "./AgentBudgetVault.t.sol";
import {AgentBudgetVault} from "../contracts/AgentBudgetVault.sol";
import {IAgentBudgetVault} from "../contracts/IAgentBudgetVault.sol";
import {MockUSDC} from "../contracts/MockUSDC.sol";
import {DenyCodes} from "../contracts/DenyCodes.sol";

/// The auditor rebuilds historical vault state from logs only (no archive eth_call). This handler
/// applies ONLY the vault's logs to a shadow state after every call and compares it with the
/// getters, so any event that stops carrying what replay needs fails here.
contract ReplayHandler is Test {
    uint256 internal constant NO_JOB = type(uint256).max;
    AgentBudgetVault internal v;
    MockUSDC internal usdc;
    address internal founder;
    address internal agent;
    address[] internal vendors;

    // shadow state rebuilt from logs
    uint256 public sBudget;
    uint256 public sCommitted;
    uint256 public sDeadline;
    bool public sPaused;
    uint256 public sMaxHold;
    mapping(address => bool) internal sAllowed;

    struct J {
        address vendor;
        uint256 held;
        uint256 paid;
        bool closed;
    }

    J[] internal sJobs;
    uint256 public totalPaid;

    // ghost counters (coverage of money-moving paths)
    uint256 public okOpen;
    uint256 public okTopUp;
    uint256 public okAgentSettle;
    uint256 public okFounderSettle;
    uint256 public okClose;
    uint256 public nDenied;
    uint256 public nRecord;
    uint256 public nFund;

    constructor(AgentBudgetVault v_, MockUSDC u_, address f_, address a_, address[] memory vs) {
        v = v_;
        usdc = u_;
        founder = f_;
        agent = a_;
        vendors = vs;
        sBudget = v.budget();
        sCommitted = v.committed();
        sDeadline = v.deadline();
        sPaused = v.paused();
        sMaxHold = v.maxHold();
        for (uint256 i = 0; i < vs.length; i++) {
            sAllowed[vs[i]] = v.vendorAllowed(vs[i]);
        }
    }

    // ---------------------------------------------------------------- replay
    function _apply() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 vaultLogs;
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(v)) continue;
            vaultLogs++;
            bytes32 t = l.topics[0];
            if (t == IAgentBudgetVault.Funded.selector) {
                (uint256 a, uint256 d) = abi.decode(l.data, (uint256, uint256));
                sBudget += a;
                sDeadline = d;
            } else if (t == IAgentBudgetVault.VendorSet.selector) {
                sAllowed[address(uint160(uint256(l.topics[1])))] = abi.decode(l.data, (bool));
            } else if (t == IAgentBudgetVault.MaxHoldSet.selector) {
                sMaxHold = abi.decode(l.data, (uint256));
            } else if (t == IAgentBudgetVault.PausedSet.selector) {
                sPaused = abi.decode(l.data, (bool));
            } else if (t == IAgentBudgetVault.HoldOpened.selector) {
                (, uint256 g) = abi.decode(l.data, (uint256, uint256));
                assertEq(uint256(l.topics[1]), sJobs.length, "HoldOpened jobId is the next id");
                sJobs.push(J({vendor: address(uint160(uint256(l.topics[2]))), held: g, paid: 0, closed: false}));
                sCommitted += g;
            } else if (t == IAgentBudgetVault.ToppedUp.selector) {
                (, uint256 g) = abi.decode(l.data, (uint256, uint256));
                sJobs[uint256(l.topics[1])].held += g;
                sCommitted += g;
            } else if (t == IAgentBudgetVault.Settled.selector) {
                (uint256 n, uint256 f) = abi.decode(l.data, (uint256, uint256));
                J storage j = sJobs[uint256(l.topics[1])];
                assertEq(address(uint160(uint256(l.topics[2]))), j.vendor, "Settled payee == job vendor");
                j.paid += n + f;
                totalPaid += n + f;
            } else if (t == IAgentBudgetVault.Closed.selector) {
                uint256 rel = abi.decode(l.data, (uint256));
                J storage j = sJobs[uint256(l.topics[1])];
                assertEq(rel, j.held - j.paid, "released == held - paid");
                j.closed = true;
                sCommitted -= rel;
            } else if (t == IAgentBudgetVault.Refunded.selector) {
                sBudget -= abi.decode(l.data, (uint256));
            } else if (t == IAgentBudgetVault.Denied.selector) {
                nDenied++;
            } else {
                revert("unknown vault log");
            }
        }
        assertEq(vaultLogs, 1, "every vault call emits exactly one vault log");
        _compare();
    }

    function _compare() internal view {
        assertEq(v.budget(), sBudget, "budget");
        assertEq(v.committed(), sCommitted, "committed");
        assertEq(v.deadline(), sDeadline, "deadline");
        assertEq(v.paused(), sPaused, "paused");
        assertEq(v.maxHold(), sMaxHold, "maxHold");
        for (uint256 i = 0; i < vendors.length; i++) {
            assertEq(v.vendorAllowed(vendors[i]), sAllowed[vendors[i]], "vendorAllowed");
        }
        assertEq(v.jobCount(), sJobs.length, "jobCount");
        for (uint256 i = 0; i < sJobs.length; i++) {
            IAgentBudgetVault.Job memory j = v.getJob(i);
            assertEq(j.vendor, sJobs[i].vendor);
            assertEq(j.held, sJobs[i].held);
            assertEq(j.paid, sJobs[i].paid);
            assertEq(j.closed, sJobs[i].closed);
        }
    }

    function _liveJob(uint256 seed) internal view returns (bool ok, uint256 id) {
        uint256 n = sJobs.length;
        if (n == 0) return (false, 0);
        for (uint256 k = 0; k < n; k++) {
            id = (seed % n + k) % n; // seed may be uint256.max: reduce first
            if (!sJobs[id].closed) return (true, id);
        }
        return (false, 0);
    }

    // ---------------------------------------------------------------- actions
    /// half the time the amount is bounded by the free budget, so the window where only the fee
    /// decides OVER_BUDGET_WITH_FEE (free/1.03 < net <= free) is actually exercised
    function _amount(uint256 net, uint256 seed) internal view returns (uint256) {
        uint256 free = v.budget() - v.committed();
        if (seed % 2 == 0 && free > 0) return bound(net, free - free / 40, free);
        return bound(net, 0, 7e6);
    }

    function open(uint256 vi, uint256 net) external {
        uint256 amt = _amount(net, vi); // before prank: _amount makes external calls
        vm.recordLogs();
        vm.prank(agent);
        if (v.open(vendors[vi % vendors.length], amt, bytes32(vi)) != NO_JOB) okOpen++;
        _apply();
    }

    function topUp(uint256 seed, uint256 net) external {
        (bool ok, uint256 id) = _liveJob(seed);
        if (!ok) return;
        uint256 amt = _amount(net, seed >> 1);
        vm.recordLogs();
        vm.prank(agent);
        if (v.topUp(id, amt, bytes32(seed))) okTopUp++;
        _apply();
    }

    function settle(uint256 seed, uint256 net, bool asFounder) external {
        (bool ok, uint256 id) = _liveJob(seed);
        if (!ok) return;
        uint256 avail = sJobs[id].held - sJobs[id].paid;
        vm.recordLogs();
        vm.prank(asFounder ? founder : agent);
        bool done = v.settle(id, bound(net, 0, avail + 2), bytes32(seed));
        if (done && asFounder) okFounderSettle++;
        if (done && !asFounder) okAgentSettle++;
        _apply();
    }

    function close(uint256 seed, bool asFounder) external {
        (bool ok, uint256 id) = _liveJob(seed);
        if (!ok) return;
        vm.recordLogs();
        vm.prank(asFounder ? founder : agent);
        if (v.close(id, bytes32(seed))) okClose++;
        _apply();
    }

    function refund(uint256 amount) external {
        uint256 free = v.budget() - v.committed();
        vm.recordLogs();
        vm.prank(founder);
        v.refund(bound(amount, 0, free), bytes32(amount));
        _apply();
    }

    /// mostly unpaused, so agent paths are actually exercised
    function setPaused(uint256 seed) external {
        vm.recordLogs();
        vm.prank(founder);
        v.setPaused(seed % 5 == 0, bytes32(seed));
        _apply();
    }

    function toggleVendor(uint256 vi, uint256 seed) external {
        vm.recordLogs();
        vm.prank(founder);
        v.setVendor(vendors[vi % vendors.length], seed % 4 != 0);
        _apply();
    }

    /// keeps the deadline reachable but not permanent
    function fund(uint256 amount, uint256 ahead) external {
        amount = bound(amount, 0, 5e6);
        vm.recordLogs();
        vm.prank(founder);
        v.fund(amount, block.timestamp + bound(ahead, 60, 4 hours));
        nFund++;
        _apply();
    }

    function recordDecision(uint256 id, uint256 codeSeed) external {
        bytes32[3] memory codes = [DenyCodes.QWEN_DENIED, DenyCodes.READ_FAILED, DenyCodes.GPU_TYPE_NOT_ALLOWED];
        vm.recordLogs();
        vm.prank(codeSeed % 2 == 0 ? agent : founder);
        v.recordDecision(id, codes[codeSeed % 3], bytes32(codeSeed));
        nRecord++;
        _apply();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 20 minutes));
    }
}

contract VaultReplayTest is VaultBase {
    ReplayHandler internal h;

    function setUp() public override {
        super.setUp();
        address[] memory vs = new address[](5);
        vs[0] = A;
        vs[1] = B;
        vs[2] = C;
        vs[3] = INF;
        vs[4] = BAD;
        h = new ReplayHandler(v, usdc, founder, agent, vs);
        // the founder can keep funding during the campaign
        usdc.mint(founder, 1_000_000e6);
        vm.prank(founder);
        usdc.approve(address(v), type(uint256).max);
        targetContract(address(h));
    }

    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_replayMatchesGetters() public view {
        assertEq(h.sBudget(), v.budget());
        assertEq(h.sCommitted(), v.committed());
    }

    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_balanceEqualsBudgetMinusPaid() public view {
        assertEq(usdc.balanceOf(address(v)), v.budget() - h.totalPaid());
    }

    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_committedWithinBudget() public view {
        assertLe(v.committed(), v.budget());
    }

    /// Deterministic coverage: the handler really reaches every money-moving path (RT-1).
    function test_handlerReachesMoneyMovingPaths() public {
        for (uint256 i = 1; i <= 600; i++) {
            uint256 r = uint256(keccak256(abi.encode(i)));
            uint256 op = r % 14;
            if (op <= 1) h.open(r >> 8, r >> 16);
            else if (op <= 4) h.topUp(r >> 8, r >> 16);
            else if (op <= 6) h.settle(r >> 8, r >> 16, false);
            else if (op == 7) h.settle(r >> 8, r >> 16, true);
            else if (op == 8) h.close(r >> 8, (r >> 24) % 2 == 0);
            else if (op == 9) h.setPaused(r >> 8);
            else if (op == 10) h.toggleVendor(r >> 8, r >> 16);
            else if (op == 11) h.fund(r >> 8, r >> 16);
            else if (op == 12) h.recordDecision(r >> 8, r >> 16);
            else h.warp(r >> 8);
        }
        assertGt(h.okOpen(), 20, "open");
        assertGt(h.okTopUp(), 10, "topUp");
        assertGt(h.okAgentSettle(), 10, "agent settle");
        assertGt(h.okFounderSettle(), 10, "founder settle");
        assertGt(h.okClose(), 10, "close");
        assertGt(h.nDenied(), 10, "denied");
        assertGt(h.nRecord(), 10, "recordDecision");
    }
}
