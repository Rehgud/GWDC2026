// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
}

/// Akash-style escrow. The founder's deposit is the hard cap. The agent opens a per-job hold for ONE
/// allowlisted vendor, tops it up, and settles actual usage (+3% fee) out of the hold.
/// A rule violation by an authorized caller moves no funds: it emits Denied and returns NO_JOB / false.
/// Only Unauthorized, JobClosed (incl. unknown id), refund OverBudget and token failures revert.
/// Check order (shared with rules.ts): AUTH -> job exists/open -> PAUSED -> PAST_DEADLINE
///   -> VENDOR_NOT_ALLOWED -> OVER_MAX_HOLD (net) -> OVER_BUDGET_WITH_FEE / OVER_HOLD (gross).
contract AgentBudgetVault {
    uint256 public constant NO_JOB = type(uint256).max;
    uint256 public constant feeBps = 300;

    // Same ASCII literals as codes.ts: stringToHex(code, { size: 32 }).
    bytes32 constant PAUSED = "PAUSED";
    bytes32 constant PAST_DEADLINE = "PAST_DEADLINE";
    bytes32 constant VENDOR_NOT_ALLOWED = "VENDOR_NOT_ALLOWED";
    bytes32 constant OVER_MAX_HOLD = "OVER_MAX_HOLD";
    bytes32 constant OVER_BUDGET_WITH_FEE = "OVER_BUDGET_WITH_FEE";
    bytes32 constant OVER_HOLD = "OVER_HOLD";

    IERC20 public immutable usdc;
    address public immutable founder;
    address public immutable agent;
    address public immutable feeTo;
    address public immutable inferencePayee; // Kiln reimbursement address, fee-exempt

    uint256 public budget;    // deposited minus refunded: the cap
    uint256 public committed; // open holds + everything paid, gross. Invariant: committed <= budget
    uint256 public maxHold;   // per-call cap on the net amount of open/topUp
    uint64 public deadline;
    bool public paused;
    mapping(address => bool) public vendorAllowed;

    struct Job { address vendor; uint256 held; uint256 paid; bool closed; }
    Job[] public jobs;

    event Funded(uint256 amount, uint256 budget, uint64 deadline);
    event VendorSet(address indexed vendor, bool allowed);
    event MaxHoldSet(uint256 maxHold);
    event PausedSet(bool paused, bytes32 reasonHash);
    event HoldOpened(uint256 indexed jobId, address indexed vendor, uint256 gross, bytes32 indexed rec);
    event ToppedUp(uint256 indexed jobId, uint256 gross, bytes32 indexed rec);
    event Settled(uint256 indexed jobId, address indexed vendor, uint256 amount, uint256 fee, bytes32 indexed rec);
    event Closed(uint256 indexed jobId, uint256 released, bytes32 rec);
    event Refunded(uint256 amount, bytes32 rec);
    /// enforced = true when a contract rule stopped the call, false when the backend recorded
    /// an off-chain (gate/Qwen) denial via recordDecision.
    event Denied(uint256 indexed jobId, bytes32 indexed code, bytes32 indexed rec, bool enforced);

    error Unauthorized();
    error JobClosed();
    error OverBudget(uint256 amount, uint256 left);

    constructor(IERC20 _usdc, address _agent, address _feeTo, address _inferencePayee) {
        (usdc, founder, agent, feeTo, inferencePayee) = (_usdc, msg.sender, _agent, _feeTo, _inferencePayee);
    }

    modifier onlyFounder() { if (msg.sender != founder) revert Unauthorized(); _; }
    modifier onlyAgent() { if (msg.sender != agent) revert Unauthorized(); _; }

    function gross(address vendor, uint256 amount) public view returns (uint256) {
        return vendor == inferencePayee ? amount : amount + amount * feeBps / 10_000;
    }

    function jobCount() external view returns (uint256) { return jobs.length; }

    // ---- founder ----
    /// Overwrites deadline: always pass it explicitly.
    function fund(uint256 amount, uint64 _deadline) external onlyFounder {
        require(usdc.transferFrom(msg.sender, address(this), amount));
        budget += amount;
        deadline = _deadline;
        emit Funded(amount, budget, _deadline);
    }
    function setVendor(address v, bool ok) external onlyFounder { vendorAllowed[v] = ok; emit VendorSet(v, ok); }
    function setMaxHold(uint256 v) external onlyFounder { maxHold = v; emit MaxHoldSet(v); }
    function setPaused(bool p, bytes32 reasonHash) external onlyFounder { paused = p; emit PausedSet(p, reasonHash); }
    function refund(uint256 amount, bytes32 rec) external onlyFounder {
        if (amount > budget - committed) revert OverBudget(amount, budget - committed);
        budget -= amount;
        require(usdc.transfer(founder, amount));
        emit Refunded(amount, rec);
    }

    // ---- agent ----
    /// All checks run before jobs.push, so a denied open creates no job.
    function open(address vendor, uint256 amount, bytes32 rec) external onlyAgent returns (uint256 id) {
        bytes32 c = _reserveCode(vendor, amount);
        if (c != 0) { _deny(NO_JOB, c, rec); return NO_JOB; }
        uint256 g = gross(vendor, amount);
        id = jobs.length;
        jobs.push(Job(vendor, g, 0, false));
        committed += g;
        emit HoldOpened(id, vendor, g, rec);
    }

    function topUp(uint256 id, uint256 amount, bytes32 rec) external onlyAgent returns (bool) {
        Job storage j = _job(id);
        bytes32 c = _reserveCode(j.vendor, amount);
        if (c != 0) return _deny(id, c, rec);
        uint256 g = gross(j.vendor, amount);
        j.held += g;
        committed += g;
        emit ToppedUp(id, g, rec);
        return true;
    }

    /// Off-chain (gate/Qwen) denial. jobId = NO_JOB before a job exists.
    function recordDecision(uint256 jobId, bytes32 code, bytes32 rec) external {
        _isAgent();
        emit Denied(jobId, code, rec, false);
    }

    // ---- agent or founder. The founder bypasses pause, deadline and the allowlist re-check. ----
    function settle(uint256 id, uint256 amount, bytes32 rec) external returns (bool) {
        bool isAgent = _isAgent();
        Job storage j = _job(id);
        if (isAgent) {
            bytes32 c = _liveCode(j.vendor);
            if (c != 0) return _deny(id, c, rec);
        }
        // net first, so a huge amount can't overflow the fee math
        if (amount > j.held || gross(j.vendor, amount) > j.held) return _deny(id, OVER_HOLD, rec);
        uint256 g = gross(j.vendor, amount);
        j.held -= g;
        j.paid += g; // committed unchanged: reserved -> spent
        require(usdc.transfer(j.vendor, amount));
        if (g > amount) require(usdc.transfer(feeTo, g - amount));
        emit Settled(id, j.vendor, amount, g - amount, rec);
        return true;
    }

    function close(uint256 id, bytes32 rec) external returns (bool) {
        bool isAgent = _isAgent();
        Job storage j = _job(id);
        if (isAgent) {
            bytes32 c = paused ? PAUSED : block.timestamp >= deadline ? PAST_DEADLINE : bytes32(0);
            if (c != 0) return _deny(id, c, rec);
        }
        uint256 released = j.held;
        j.closed = true;
        j.held = 0;
        committed -= released;
        emit Closed(id, released, rec);
        return true;
    }

    // ---- internal ----
    /// true = agent, false = founder, anyone else reverts.
    function _isAgent() internal view returns (bool) {
        if (msg.sender == agent) return true;
        if (msg.sender != founder) revert Unauthorized();
        return false;
    }

    function _job(uint256 id) internal view returns (Job storage j) {
        if (id >= jobs.length) revert JobClosed();
        j = jobs[id];
        if (j.closed) revert JobClosed();
    }

    function _liveCode(address vendor) internal view returns (bytes32) {
        if (paused) return PAUSED;
        if (block.timestamp >= deadline) return PAST_DEADLINE;
        if (!vendorAllowed[vendor]) return VENDOR_NOT_ALLOWED;
        return 0;
    }

    function _reserveCode(address vendor, uint256 amount) internal view returns (bytes32 c) {
        c = _liveCode(vendor);
        if (c != 0) return c;
        if (amount > maxHold) return OVER_MAX_HOLD;
        if (gross(vendor, amount) > budget - committed) return OVER_BUDGET_WITH_FEE;
    }

    function _deny(uint256 id, bytes32 code, bytes32 rec) internal returns (bool) {
        emit Denied(id, code, rec, true);
        return false;
    }
}
