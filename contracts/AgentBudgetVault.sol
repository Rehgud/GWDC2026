// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAgentBudgetVault} from "./IAgentBudgetVault.sol";
import {DenyCodes} from "./DenyCodes.sol";
import {FeeMath} from "./FeeMath.sol";

/// @title AgentBudgetVault — Akash-style escrow with rechargeable holds (see IAgentBudgetVault for the rules)
contract AgentBudgetVault is IAgentBudgetVault {
    uint256 public constant NO_JOB = type(uint256).max;

    address public immutable override usdc;
    address public immutable override founder;
    address public immutable override agent;
    address public immutable override feeTo;
    uint256 public immutable override feeBps;
    address public immutable override inferencePayee;

    uint256 public override budget;
    uint256 public override committed;
    uint256 public override deadline;
    bool public override paused;
    uint256 public override maxHold;
    mapping(address => bool) public override vendorAllowed;

    Job[] internal _jobs;

    constructor(address usdc_, address agent_, address feeTo_, uint256 feeBps_, address inferencePayee_) {
        require(
            usdc_.code.length != 0 && agent_ != address(0) && agent_ != msg.sender && feeTo_ != address(0)
                && inferencePayee_ != address(0) && feeBps_ <= 1000,
            "bad config"
        );
        usdc = usdc_;
        founder = msg.sender;
        agent = agent_;
        feeTo = feeTo_;
        feeBps = feeBps_;
        inferencePayee = inferencePayee_;
    }

    modifier onlyFounder() {
        if (msg.sender != founder) revert Unauthorized();
        _;
    }

    // ---------------------------------------------------------------- views
    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        if (jobId >= _jobs.length) revert JobClosed();
        return _jobs[jobId];
    }

    function grossOf(address vendor, uint256 net) public view returns (uint256) {
        return FeeMath.gross(net, feeBps, vendor == inferencePayee);
    }

    // ---------------------------------------------------------------- founder
    function fund(uint256 amount, uint256 newDeadline) external onlyFounder {
        budget += amount;
        deadline = newDeadline;
        _pull(amount);
        emit Funded(amount, newDeadline);
    }

    function setVendor(address vendor, bool allowed) external onlyFounder {
        vendorAllowed[vendor] = allowed;
        emit VendorSet(vendor, allowed);
    }

    function setMaxHold(uint256 newMaxHold) external onlyFounder {
        maxHold = newMaxHold;
        emit MaxHoldSet(newMaxHold);
    }

    function setPaused(bool p, bytes32 rec) external onlyFounder {
        paused = p;
        emit PausedSet(p, rec);
    }

    function refund(uint256 amount, bytes32 rec) external onlyFounder {
        if (amount > budget - committed) revert OverBudget();
        budget -= amount;
        _send(founder, amount);
        emit Refunded(amount, rec);
    }

    // ---------------------------------------------------------------- agent
    function open(address vendor, uint256 net, bytes32 rec) external returns (uint256 jobId) {
        if (msg.sender != agent) revert Unauthorized();
        bytes32 code = _reserveCheck(vendor, net);
        if (code != 0) {
            emit Denied(NO_JOB, code, rec, true);
            return NO_JOB;
        }
        uint256 g = grossOf(vendor, net);
        committed += g;
        jobId = _jobs.length;
        _jobs.push(Job({vendor: vendor, held: g, paid: 0, closed: false}));
        emit HoldOpened(jobId, vendor, net, g, rec);
    }

    function topUp(uint256 jobId, uint256 net, bytes32 rec) external returns (bool) {
        if (msg.sender != agent) revert Unauthorized();
        Job storage j = _live(jobId);
        bytes32 code = _reserveCheck(j.vendor, net);
        if (code != 0) {
            emit Denied(jobId, code, rec, true);
            return false;
        }
        uint256 g = grossOf(j.vendor, net);
        committed += g;
        j.held += g;
        emit ToppedUp(jobId, net, g, rec);
        return true;
    }

    function settle(uint256 jobId, uint256 net, bytes32 rec) external returns (bool) {
        bool byFounder = msg.sender == founder;
        if (!byFounder && msg.sender != agent) revert Unauthorized();
        Job storage j = _live(jobId);
        bytes32 code;
        if (!byFounder) code = _agentGate(true, j.vendor);
        uint256 avail = j.held - j.paid;
        uint256 fee;
        if (code == 0) {
            // compare the net first so a huge net cannot overflow gross (no Panic 0x11)
            if (net > avail) {
                code = DenyCodes.OVER_HOLD;
            } else {
                fee = FeeMath.fee(net, feeBps, j.vendor == inferencePayee);
                if (net + fee > avail) code = DenyCodes.OVER_HOLD;
            }
        }
        if (code != 0) {
            emit Denied(jobId, code, rec, true);
            return false;
        }
        j.paid += net + fee;
        _send(j.vendor, net);
        if (fee != 0) _send(feeTo, fee);
        emit Settled(jobId, j.vendor, net, fee, rec);
        return true;
    }

    function close(uint256 jobId, bytes32 rec) external returns (bool) {
        bool byFounder = msg.sender == founder;
        if (!byFounder && msg.sender != agent) revert Unauthorized();
        Job storage j = _live(jobId);
        if (!byFounder) {
            bytes32 code = _agentGate(false, j.vendor);
            if (code != 0) {
                emit Denied(jobId, code, rec, true);
                return false;
            }
        }
        uint256 released = j.held - j.paid;
        j.closed = true;
        committed -= released;
        emit Closed(jobId, released, rec);
        return true;
    }

    function recordDecision(uint256 jobId, bytes32 code, bytes32 rec) external {
        if (msg.sender != agent && msg.sender != founder) revert Unauthorized();
        emit Denied(jobId, code, rec, false);
    }

    // ---------------------------------------------------------------- internals
    function _live(uint256 jobId) internal view returns (Job storage j) {
        if (jobId >= _jobs.length) revert JobClosed();
        j = _jobs[jobId];
        if (j.closed) revert JobClosed();
    }

    /// PAUSED -> PAST_DEADLINE (-> VENDOR_NOT_ALLOWED for settle, D3)
    function _agentGate(bool checkVendor, address vendor) internal view returns (bytes32) {
        if (paused) return DenyCodes.PAUSED;
        if (block.timestamp >= deadline) return DenyCodes.PAST_DEADLINE;
        if (checkVendor && !vendorAllowed[vendor]) return DenyCodes.VENDOR_NOT_ALLOWED;
        return 0;
    }

    /// open/topUp: PAUSED -> PAST_DEADLINE -> VENDOR_NOT_ALLOWED -> OVER_MAX_HOLD -> OVER_BUDGET_WITH_FEE
    function _reserveCheck(address vendor, uint256 net) internal view returns (bytes32) {
        bytes32 code = _agentGate(true, vendor);
        if (code != 0) return code;
        if (net > maxHold) return DenyCodes.OVER_MAX_HOLD;
        uint256 free = budget - committed;
        if (net > free) return DenyCodes.OVER_BUDGET_WITH_FEE;
        if (grossOf(vendor, net) > free) return DenyCodes.OVER_BUDGET_WITH_FEE;
        return 0;
    }

    function _pull(uint256 amount) internal {
        (bool ok, bytes memory data) =
            usdc.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = usdc.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
