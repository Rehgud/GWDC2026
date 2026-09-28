// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentBudgetVault, IERC20} from "../contracts/AgentBudgetVault.sol";
import {MockUSDC} from "../contracts/MockUSDC.sol";

/// Drives every entry point with random callers, amounts, ids, pauses, warps and allowlist changes.
contract VaultHandler is Test {
    MockUSDC public usdc;
    AgentBudgetVault public v;
    address public founder = address(0xF0);
    address public agent = address(0xA9);
    address[4] public payees = [address(0x1A), address(0x1B), address(0x1C), address(0x11)]; // last = INFERENCE
    uint256 public deniedMoved; // a Denied/false return that changed money state
    uint256 public badRevert;   // a revert outside {Unauthorized, JobClosed, OverBudget}
    uint256 public outflow;     // tokens that left the vault through settle

    constructor() {
        usdc = new MockUSDC();
        vm.prank(founder);
        v = new AgentBudgetVault(IERC20(address(usdc)), agent, address(0xFE), payees[3]);
        usdc.mint(founder, 1e30);
        vm.startPrank(founder);
        usdc.approve(address(v), type(uint256).max);
        v.fund(20e6, uint64(block.timestamp + 1 days));
        for (uint256 i; i < 4; i++) v.setVendor(payees[i], true);
        v.setMaxHold(6e6);
        vm.stopPrank();
    }

    function _state() internal view returns (bytes32) {
        return keccak256(abi.encode(v.budget(), v.committed(), v.jobCount(), usdc.balanceOf(address(v))));
    }
    function _who(uint256 s) internal view returns (address) { return s % 2 == 0 ? agent : founder; }
    function _id(uint256 s) internal view returns (uint256) { return s % (v.jobCount() + 2); }
    function _ok(bytes memory err) internal {
        bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
        if (sel != AgentBudgetVault.JobClosed.selector && sel != AgentBudgetVault.Unauthorized.selector
            && sel != AgentBudgetVault.OverBudget.selector) badRevert++;
    }

    function open(uint256 s, uint256 amt) external {
        amt = bound(amt, 0, 7e6);
        bytes32 h = _state();
        address w = _who(s);
        vm.prank(w);
        try v.open(payees[s % 4], amt, "r") returns (uint256 id) { if (id == type(uint256).max && h != _state()) deniedMoved++; }
        catch (bytes memory e) { if (w == agent) _ok(e); }
    }
    function topUp(uint256 s, uint256 amt) external {
        amt = bound(amt, 0, 7e6);
        bytes32 h = _state();
        vm.prank(_who(s));
        try v.topUp(_id(s), amt, "r") returns (bool ok) { if (!ok && h != _state()) deniedMoved++; }
        catch (bytes memory e) { _ok(e); }
    }
    function settle(uint256 s, uint256 amt) external {
        amt = bound(amt, 0, 8e6);
        bytes32 h = _state();
        uint256 b0 = usdc.balanceOf(address(v));
        vm.prank(_who(s));
        try v.settle(_id(s), amt, "r") returns (bool ok) {
            if (!ok && h != _state()) deniedMoved++;
            outflow += b0 - usdc.balanceOf(address(v));
        } catch (bytes memory e) { _ok(e); }
    }
    function close(uint256 s) external {
        bytes32 h = _state();
        vm.prank(_who(s));
        try v.close(_id(s), "r") returns (bool ok) { if (!ok && h != _state()) deniedMoved++; }
        catch (bytes memory e) { _ok(e); }
    }
    function pause(bool p) external { vm.prank(founder); v.setPaused(p, 0); }
    function warp(uint256 d) external { vm.warp(block.timestamp + bound(d, 0, 2 days)); }
    function fund(uint256 a, uint256 d) external {
        vm.prank(founder);
        v.fund(bound(a, 0, 5e6), uint64(block.timestamp + bound(d, 0, 2 days)));
    }
    function refund(uint256 a) external {
        uint256 left = v.budget() - v.committed();
        vm.prank(founder);
        v.refund(bound(a, 0, left), "r");
    }
    function setVendor(uint256 s, bool ok) external { vm.prank(founder); v.setVendor(payees[s % 4], ok); }
    function setMaxHold(uint256 m) external { vm.prank(founder); v.setMaxHold(bound(m, 0, 10e6)); }
}

/// C11: money invariants over random call sequences.
contract AgentBudgetVaultInvariantTest is Test {
    VaultHandler h;

    function setUp() public {
        h = new VaultHandler();
        targetContract(address(h));
    }

    function invariant_money() public view {
        AgentBudgetVault v = h.v();
        uint256 held;
        uint256 paid;
        for (uint256 i; i < v.jobCount(); i++) {
            (, uint256 hh, uint256 p, bool closed) = v.jobs(i);
            held += hh;
            paid += p;
            if (closed) assertEq(hh, 0, "closed job holds funds");
        }
        assertLe(v.committed(), v.budget(), "committed > budget");
        assertEq(v.committed(), held + paid, "committed != held + paid");
        assertEq(h.usdc().balanceOf(address(v)), v.budget() - paid, "balance != budget - paid");
        assertEq(h.outflow(), paid, "outflow != paid");
        assertEq(h.deniedMoved(), 0, "a denial moved money");
        assertEq(h.badRevert(), 0, "unexpected revert");
    }
}
