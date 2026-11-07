// Reads every record an index lists through host-policy.json with host-core's
// display seam, and exits 1 when the policy refuses one. The index is the path given
// as the first argument. publish.yml passes the index it built.
import { readFileSync } from 'node:fs';
import { displayOf, parseIndex, parsePolicy } from '@typedstandards/host-core';

const policy = parsePolicy(JSON.parse(readFileSync(process.argv[3] ?? 'host-policy.json', 'utf8')));
const index = parseIndex(JSON.parse(readFileSync(process.argv[2] ?? 'site/records.json', 'utf8')));

let refused = 0;
for (const record of index.records) {
  try {
    const shown = displayOf(record, policy);
    console.log(`${record.name}: ${record.status}, displayed as ${shown.as} (rule ${shown.rule})`);
  } catch (err) {
    refused += 1;
    console.log(`${record.name}: ${record.status}, refused: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`display: ${index.records.length} listed, ${refused} refused`);
process.exitCode = refused === 0 ? 0 : 1;
