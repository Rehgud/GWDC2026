// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice gross(v, a) = v == INFERENCE ? a : a + floor(a * feeBps / 10000)   ([IFACE])
///         Same function as backend/rules.ts gross(); fixtures/fee-cases.json pins both.
///         The fee is computed as (a / 10000) * bps + ((a % 10000) * bps) / 10000, which equals
///         floor(a * bps / 10000) exactly but cannot overflow for any a (bps <= 10000).
library FeeMath {
    uint256 internal constant BPS = 10_000;

    function fee(uint256 net, uint256 feeBps, bool exempt) internal pure returns (uint256) {
        if (exempt) return 0;
        // exact floor(net*bps/1e4) without overflow: a = 1e4*q + r  =>  q*bps + floor(r*bps/1e4)
        // forge-lint: disable-next-line(divide-before-multiply)
        return (net / BPS) * feeBps + ((net % BPS) * feeBps) / BPS;
    }

    function gross(uint256 net, uint256 feeBps, bool exempt) internal pure returns (uint256) {
        return net + fee(net, feeBps, exempt);
    }
}
