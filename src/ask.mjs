#!/usr/bin/env node
// npm run ask -- "<question>"
// Runs the chain, prints the answer, writes and checks the signed record, and
// prints its verify link. Credentials arrive only through the environment, from
// op run --env-file=op.env; nothing here prints them.
import { loadConfig } from './config.mjs';
import { runChain } from './chain.mjs';
import { runName, writeRecord } from './record.mjs';
import { writeReplay } from './replay.mjs';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('usage: npm run ask -- "<question>"');
  process.exit(2);
}
for (const name of ['TINFOIL_API_KEY', 'TYPEDSTANDARDS_SIGNING_SEED_B64']) {
  if (!process.env[name]) {
    console.error(`${name} is not set. Run through: op run --env-file=op.env -- npm run ask -- "<question>"`);
    process.exit(3);
  }
}

const config = loadConfig();
const events = [];
const started = Date.now();
const emit = (event) => {
  events.push({ t: Date.now() - started, ...event });
  const e = event;
  if (e.step === 'source') console.error(`[data]   ${e.server} -> ${e.portal}`);
  if (e.step === 'router') console.error(`[router] ${e.tools.join(', ')}; prompt ${e.promptChars} chars`);
  if (e.step === 'attestation') console.error(`[enclave] ${e.configRepo} ${e.releaseDigest.slice(0, 12)}... verified=${e.securityVerified}`);
  if (e.step === 'model' && e.status === 'request') console.error(`[model]  ${config.model} request ${e.index}`);
  if (e.step === 'tool' && e.status === 'call') console.error(`[tool]   ${e.name} ${JSON.stringify(e.args).slice(0, 140)}`);
  if (e.step === 'tool' && e.status === 'error') console.error(`[tool]   error: ${e.message}`);
};

const run = await runChain(question, config, emit);
const name = runName(new Date(run.startedAt));
const record = writeRecord(run, config, name);
const bundleUrl = `${config.origin}/bundles/${name}.bundle.json`;
const verifyLink = `https://typedstandards.org/verify?url=${encodeURIComponent(bundleUrl)}`;
writeReplay(name, run, record, events, verifyLink);

console.log(`\n${run.answer.trim()}\n`);
console.log(`record:  records/${name}.signed.json (checked offline: ok=${record.verify.ok})`);
console.log(`files:   docs/runs/${name}/`);
console.log(`verify:  ${verifyLink}`);
console.log('         (live once the commit is pushed and Pages has deployed)');
