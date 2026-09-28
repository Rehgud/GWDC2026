// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Decision codes as bytes32 ASCII literals ([IFACE]). Same list and spelling as
///         backend/codes.ts; test/Fixtures.t.sol checks every literal against
///         fixtures/deny-codes.json, which is generated from codes.ts.
library DenyCodes {
    // enforced by the vault (Denied with enforced=true)
    bytes32 internal constant PAUSED = "PAUSED";
    bytes32 internal constant PAST_DEADLINE = "PAST_DEADLINE";
    bytes32 internal constant VENDOR_NOT_ALLOWED = "VENDOR_NOT_ALLOWED";
    bytes32 internal constant OVER_MAX_HOLD = "OVER_MAX_HOLD";
    bytes32 internal constant OVER_BUDGET_WITH_FEE = "OVER_BUDGET_WITH_FEE";
    bytes32 internal constant OVER_HOLD = "OVER_HOLD";
    // gate only (arrive on-chain through recordDecision, enforced=false)
    bytes32 internal constant GPU_TYPE_NOT_ALLOWED = "GPU_TYPE_NOT_ALLOWED";
    bytes32 internal constant OVER_JOB_CAP = "OVER_JOB_CAP";
    bytes32 internal constant NO_CAPACITY = "NO_CAPACITY";
    bytes32 internal constant NAN_DETECTED = "NAN_DETECTED";
    bytes32 internal constant LOSS_PLATEAU = "LOSS_PLATEAU";
    // CFO review
    bytes32 internal constant QWEN_DENIED = "QWEN_DENIED";
    bytes32 internal constant QWEN_UNAVAILABLE = "QWEN_UNAVAILABLE";
    bytes32 internal constant QWEN_UNPARSEABLE = "QWEN_UNPARSEABLE";
    // operational
    bytes32 internal constant READ_FAILED = "READ_FAILED";
    bytes32 internal constant TOPUP_TIMEOUT = "TOPUP_TIMEOUT";
    bytes32 internal constant LLM_CALL_CAP = "LLM_CALL_CAP";
}
