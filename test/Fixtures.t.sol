// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DenyCodes} from "../contracts/DenyCodes.sol";
import {FeeMath} from "../contracts/FeeMath.sol";

/// C12: the same fixture files are read by forge and node:test.
contract FixturesTest is Test {
    function _codes() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/fixtures/deny-codes.json"));
    }

    function test_denyCodeLiteralsMatchTs() public view {
        string memory j = _codes();
        assertEq(vm.parseJsonBytes32(j, ".PAUSED"), DenyCodes.PAUSED);
        assertEq(vm.parseJsonBytes32(j, ".PAST_DEADLINE"), DenyCodes.PAST_DEADLINE);
        assertEq(vm.parseJsonBytes32(j, ".VENDOR_NOT_ALLOWED"), DenyCodes.VENDOR_NOT_ALLOWED);
        assertEq(vm.parseJsonBytes32(j, ".OVER_MAX_HOLD"), DenyCodes.OVER_MAX_HOLD);
        assertEq(vm.parseJsonBytes32(j, ".OVER_BUDGET_WITH_FEE"), DenyCodes.OVER_BUDGET_WITH_FEE);
        assertEq(vm.parseJsonBytes32(j, ".OVER_HOLD"), DenyCodes.OVER_HOLD);
        assertEq(vm.parseJsonBytes32(j, ".GPU_TYPE_NOT_ALLOWED"), DenyCodes.GPU_TYPE_NOT_ALLOWED);
        assertEq(vm.parseJsonBytes32(j, ".OVER_JOB_CAP"), DenyCodes.OVER_JOB_CAP);
        assertEq(vm.parseJsonBytes32(j, ".NO_CAPACITY"), DenyCodes.NO_CAPACITY);
        assertEq(vm.parseJsonBytes32(j, ".NAN_DETECTED"), DenyCodes.NAN_DETECTED);
        assertEq(vm.parseJsonBytes32(j, ".LOSS_PLATEAU"), DenyCodes.LOSS_PLATEAU);
        assertEq(vm.parseJsonBytes32(j, ".QWEN_DENIED"), DenyCodes.QWEN_DENIED);
        assertEq(vm.parseJsonBytes32(j, ".QWEN_UNAVAILABLE"), DenyCodes.QWEN_UNAVAILABLE);
        assertEq(vm.parseJsonBytes32(j, ".QWEN_UNPARSEABLE"), DenyCodes.QWEN_UNPARSEABLE);
        assertEq(vm.parseJsonBytes32(j, ".READ_FAILED"), DenyCodes.READ_FAILED);
        assertEq(vm.parseJsonBytes32(j, ".TOPUP_TIMEOUT"), DenyCodes.TOPUP_TIMEOUT);
        assertEq(vm.parseJsonBytes32(j, ".LLM_CALL_CAP"), DenyCodes.LLM_CALL_CAP);
        // the fixture has exactly the 17 codes above
        assertEq(vm.parseJsonKeys(j, "$").length, 17);
    }

    function test_feeMathMatchesTs() public view {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/fixtures/fee-cases.json"));
        uint256 bps = vm.parseJsonUint(j, ".feeBps");
        uint256[] memory net = vm.parseJsonUintArray(j, ".net");
        bool[] memory exempt = vm.parseJsonBoolArray(j, ".exempt");
        uint256[] memory gross_ = vm.parseJsonUintArray(j, ".gross");
        uint256[] memory fee_ = vm.parseJsonUintArray(j, ".fee");
        assertEq(bps, 300);
        assertGt(net.length, 100);
        assertEq(net.length, exempt.length);
        assertEq(net.length, gross_.length);
        assertEq(net.length, fee_.length);
        for (uint256 i = 0; i < net.length; i++) {
            assertEq(FeeMath.fee(net[i], bps, exempt[i]), fee_[i], "fee");
            assertEq(FeeMath.gross(net[i], bps, exempt[i]), gross_[i], "gross");
        }
    }

    /// fee floor: 33 -> 0, 34 -> 1 (C4)
    function test_feeFloor() public pure {
        assertEq(FeeMath.fee(33, 300, false), 0);
        assertEq(FeeMath.fee(34, 300, false), 1);
        assertEq(FeeMath.fee(34, 300, true), 0);
    }

    /// the decomposed fee equals floor(a*bps/10000) wherever the naive product does not overflow
    function testFuzz_feeDecompositionExact(uint256 a, uint16 bpsRaw) public pure {
        uint256 bps = bound(uint256(bpsRaw), 0, 10_000);
        a = bound(a, 0, type(uint256).max / 10_000);
        assertEq(FeeMath.fee(a, bps, false), (a * bps) / 10_000);
    }

    /// no Panic for any input (uint256.max included) as long as gross fits
    function testFuzz_feeNeverOverflows(uint256 a) public pure {
        FeeMath.fee(a, 300, false);
    }
}
