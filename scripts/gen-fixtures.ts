// gen-fixtures.ts — cross-language fixtures read by BOTH forge and node:test (C12).
// Source of truth: backend/codes.ts and backend/rules.ts. Regenerate with npm run gen:fixtures;
// test/ts/codes.test.ts and rules.test.ts fail if the committed files drift from the source.
import { writeFile, mkdir } from 'node:fs/promises';
import { buildDenyCodesFixture, buildFeeCasesFixture } from '../backend/fixtures.ts';

await mkdir('fixtures', { recursive: true });
await writeFile('fixtures/deny-codes.json', JSON.stringify(buildDenyCodesFixture(), null, 2) + '\n');
await writeFile('fixtures/fee-cases.json', JSON.stringify(buildFeeCasesFixture(), null, 2) + '\n');
console.log('gen-fixtures: wrote fixtures/deny-codes.json, fixtures/fee-cases.json');
