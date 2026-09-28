// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IAgentBudgetVault — the fixed interface of the CFO Agent escrow vault ([IFACE])
/// @notice Akash-style escrow on EVM: fund = AccountDeposit, open = CreateLease,
///         topUp = AccountDeposit (top-up), settle = WithdrawLease, close = CloseLease,
///         refund = remaining deposit returned on CloseDeployment.
///
/// Amount basis (one rule everywhere, see backend/rules.ts):
///   - open/topUp/settle take a NET amount (micro-USDC, 6 decimals).
///   - The vault reserves gross(v, a) = v == inferencePayee ? a : a + floor(a * feeBps / 10000).
///   - OVER_MAX_HOLD compares the NET amount with maxHold (before gross is computed).
///   - OVER_BUDGET_WITH_FEE is committed + gross > budget.
///   - Invariant: committed (open holds + paid gross) <= budget.
///
/// Denied model:
///   - A rule violation by an AUTHORIZED caller does not revert. The tx is mined, no money
///     moves, Denied(jobId, code, rec, enforced=true) is emitted, and open returns NO_JOB,
///     topUp/settle/close return false. A denied open never creates a job (all checks run
///     before jobs.push).
///   - Only these revert: Unauthorized (wrong caller), JobClosed (unknown or closed id),
///     OverBudget (refund above budget - committed), TransferFailed (token transfer).
///   - recordDecision emits the same Denied event with enforced=false for decisions the
///     gate or the CFO (Qwen) made before any money-moving tx.
///
/// Check order (the gate in backend/rules.ts uses the same order; first violation wins):
///   AUTH(revert) -> id exists(revert JobClosed) -> closed(revert JobClosed) -> PAUSED
///   -> PAST_DEADLINE -> VENDOR_NOT_ALLOWED -> OVER_MAX_HOLD -> OVER_BUDGET_WITH_FEE | OVER_HOLD
///
/// Founder path: settle skips PAUSED / PAST_DEADLINE / VENDOR_NOT_ALLOWED (OVER_HOLD still
/// applies); close is always allowed. Agent close after pause/deadline is Denied (D3).
interface IAgentBudgetVault {
    struct Job {
        address vendor;
        uint256 held; // gross reserved by open + all topUps
        uint256 paid; // gross paid out by settles (net to vendor + fee to feeTo)
        bool closed;
    }

    // ------------------------------------------------------------------ events
    event Funded(uint256 amount, uint256 deadline);
    event VendorSet(address indexed vendor, bool allowed);
    event MaxHoldSet(uint256 maxHold);
    event PausedSet(bool paused, bytes32 indexed rec);
    event HoldOpened(
        uint256 indexed jobId, address indexed vendor, uint256 net, uint256 gross, bytes32 indexed recordHash
    );
    event ToppedUp(uint256 indexed jobId, uint256 net, uint256 gross, bytes32 indexed recordHash);
    event Settled(
        uint256 indexed jobId, address indexed vendor, uint256 net, uint256 fee, bytes32 indexed recordHash
    );
    event Closed(uint256 indexed jobId, uint256 released, bytes32 indexed rec);
    event Refunded(uint256 amount, bytes32 indexed rec);
    event Denied(uint256 indexed jobId, bytes32 indexed code, bytes32 indexed rec, bool enforced);

    // ------------------------------------------------------------------ errors
    error Unauthorized();
    error JobClosed();
    error OverBudget();
    error TransferFailed();

    // ------------------------------------------------------------------ views
    function usdc() external view returns (address);
    function founder() external view returns (address);
    function agent() external view returns (address);
    function feeTo() external view returns (address);
    function feeBps() external view returns (uint256);
    function inferencePayee() external view returns (address);

    function budget() external view returns (uint256);
    function committed() external view returns (uint256);
    function deadline() external view returns (uint256);
    function paused() external view returns (bool);
    function maxHold() external view returns (uint256);
    function vendorAllowed(address vendor) external view returns (bool);

    function jobCount() external view returns (uint256);
    function getJob(uint256 jobId) external view returns (Job memory);
    /// @notice gross(vendor, net) exactly as the vault reserves it (fee floor, INFERENCE exempt).
    function grossOf(address vendor, uint256 net) external view returns (uint256);

    // ------------------------------------------------------------------ founder
    /// @notice Pull `amount` USDC from the founder and OVERWRITE the deadline.
    ///         Every script must pass cfg.deadline explicitly.
    function fund(uint256 amount, uint256 newDeadline) external;
    function setVendor(address vendor, bool allowed) external;
    function setMaxHold(uint256 newMaxHold) external;
    function setPaused(bool p, bytes32 rec) external;
    /// @notice Return up to budget - committed to the founder. Above that: revert OverBudget.
    function refund(uint256 amount, bytes32 rec) external;

    // ------------------------------------------------------------------ agent (+ founder for settle/close)
    /// @return jobId the new job id, or NO_JOB (type(uint256).max) when Denied.
    function open(address vendor, uint256 net, bytes32 rec) external returns (uint256 jobId);
    function topUp(uint256 jobId, uint256 net, bytes32 rec) external returns (bool);
    function settle(uint256 jobId, uint256 net, bytes32 rec) external returns (bool);
    function close(uint256 jobId, bytes32 rec) external returns (bool);
    /// @notice Record an off-chain denial (gate / CFO / operational code). Agent or founder only.
    function recordDecision(uint256 jobId, bytes32 code, bytes32 rec) external;
}
