// new-agent.ts — `npm run new-agent`: a NEW agent hot key for the next recorded vault
// (one run = one vault = one agent key). Writes AGENT_PK into .env (git-ignored) and prints ONLY
// the address to fund with Base Sepolia ETH. The key itself is never printed or logged.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const file = '.env';
const pk = generatePrivateKey();
const addr = privateKeyToAccount(pk).address;
const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : readFileSync('.env.example', 'utf8').split(/\r?\n/);
let found = false;
const out = lines.map((l) => {
  if (/^\s*AGENT_PK\s*=/.test(l)) {
    found = true;
    return `AGENT_PK=${pk}`;
  }
  return l;
});
if (!found) out.push(`AGENT_PK=${pk}`);
writeFileSync(file, out.join('\n'));
console.log(`new-agent: AGENT_PK written to ${file} (not printed). Fund this address with Base Sepolia ETH (>= 0.005): ${addr}`);
