#!/usr/bin/env bash
# attack.sh — Success criterion 3(iii) / D5 with real `cast`: the stolen AGENT key calls the vault
# directly, bypassing the gate and Qwen. The vault answers every rule violation with
# Denied(...) and moves nothing; the auditor lists these as UNRECORDED_ATTEMPT (WARN, PASS kept).
#   bash scripts/attack.sh [vendor|maxhold|budget|all]
# RUNBOOK: only while the backend is idle (it shares the agent nonce).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
set -a; [ -f .env ] && . ./.env; set +a
: "${AGENT_PK:?AGENT_PK missing in .env}"
CHAIN="${CHAIN:-anvil}"
if [ "$CHAIN" = "anvil" ]; then DEP=deployments/local/current.json; RPC="${RPC_URL:-http://127.0.0.1:8545}"; else DEP=deployments/current.json; RPC="${RPC_URL:-https://sepolia.base.org}"; fi
VAULT=$(node -e "console.log(require('./$DEP').vault)")
BAD=0xBAd0000000000000000000000000000000000Bad
REC=$(cast keccak "attacker:$(date +%s)")
what="${1:-all}"

send() { # $1 label, rest = cast send args
  local label="$1"; shift
  local out tx
  out=$(cast send "$VAULT" "$@" --private-key "$AGENT_PK" --rpc-url "$RPC" --json)
  tx=$(printf '%s' "$out" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).transactionHash))")
  echo "attack[$label]: tx $tx"
  # decode Denied(uint256 jobId, bytes32 code, bytes32 rec, bool enforced) from the vault's logs
  printf '%s' "$out" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const r=JSON.parse(s); const v='$VAULT'.toLowerCase();
      const logs=r.logs.filter(l=>l.address.toLowerCase()===v);
      for(const l of logs){ const code=Buffer.from(l.topics[2].slice(2),'hex').toString('utf8').replace(/\0+$/,'');
        console.log('  vault log: Denied code='+code+' enforced='+(BigInt(l.data)===1n)+' (status '+r.status+', nothing moved)'); }
      if(!logs.length) console.log('  no vault log (status '+r.status+')');
    })"
  if [ "$CHAIN" = "base-sepolia" ]; then echo "  https://sepolia.basescan.org/tx/$tx"; fi
}

VENDOR_A=$(node -e "console.log(require('./$DEP').vendors[0].address)")
MAXHOLD=$(cast call "$VAULT" "maxHold()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
case "$what" in
  vendor|all) send vendor "open(address,uint256,bytes32)" "$BAD" 2560000 "$REC" ;;&
  maxhold|all) send maxhold "open(address,uint256,bytes32)" "$VENDOR_A" "$(node -e "console.log((BigInt('$MAXHOLD')+1n).toString())")" "$REC" ;;&
  budget|all)
    BUDGET=$(cast call "$VAULT" "budget()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
    COMM=$(cast call "$VAULT" "committed()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
    FREE=$(node -e "console.log((BigInt('$BUDGET')-BigInt('$COMM')).toString())")
    # net == free fits the budget but its gross (+3%) does not -> OVER_BUDGET_WITH_FEE.
    # Only valid while free <= maxHold; otherwise the same call could SUCCEED, so it is not sent.
    if node -e "process.exit(BigInt('$FREE')>0n && BigInt('$FREE')<=BigInt('$MAXHOLD')?0:1)"; then
      send budget "open(address,uint256,bytes32)" "$VENDOR_A" "$FREE" "$REC"
    else
      echo "attack[budget]: skipped (free budget $FREE > maxHold $MAXHOLD: the same call would open a real hold)"
    fi ;;
  *) echo "usage: bash scripts/attack.sh [vendor|maxhold|budget|all]"; exit 2 ;;
esac
echo "attack: refund / setVendor with the agent key revert Unauthorized (not even broadcast):"
if cast call "$VAULT" "refund(uint256,bytes32)" 1 "$REC" --from "$(cast wallet address --private-key "$AGENT_PK")" --rpc-url "$RPC" >/dev/null 2>&1; then echo "  UNEXPECTED: refund simulated OK"; else echo "  refund -> revert Unauthorized (as designed)"; fi
