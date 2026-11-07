#!/usr/bin/env node
// npm run ask:enclave -- "<question>"
// Sends the question to Openmaxxing running in a Tinfoil Container, and files the
// record the enclave signed. Steps:
//   1. Tinfoil's SecureClient verifies the container's enclave against the public
//      config repository before anything is sent.
//   2. POST /ask, with the bearer token from OPENMAXXING_ASK_TOKEN.
//   3. The record is checked offline, and its served files against their signed hashes.
//   4. With the Tinfoil CLI installed, `tinfoil attestation verify -j` captures the
//      container's attestation, and the record's signing key is compared with the
//      attested key (crypto_material, format https://tinfoil.sh/key/spki/v1).
//   5. The record goes under enclave/ (its own host: one key per registry) and its
//      files under docs/enclave/runs/<name>/.
// Credentials arrive only through op run --env-file=op.env.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecureClient } from 'tinfoil';
import { ROOT, loadConfig } from './config.mjs';

const question = process.argv.slice(2).join(' ').trim();
const config = loadConfig();
const enclaveURL = process.env.OPENMAXXING_ENCLAVE_URL || config.enclave?.url;
const configRepo = config.enclave?.configRepo;
if (!question) { console.error('usage: npm run ask:enclave -- "<question>"'); process.exit(2); }
if (!enclaveURL) { console.error('Set OPENMAXXING_ENCLAVE_URL, or enclave.url in openmaxxing.config.json'); process.exit(2); }
if (!process.env.OPENMAXXING_ASK_TOKEN) { console.error('OPENMAXXING_ASK_TOKEN is not set: run through op run --env-file=op.env'); process.exit(3); }

const origin = `${config.origin}/enclave`;
const enclaveHost = new URL(enclaveURL).host;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 1. Verify the container's enclave.
const client = new SecureClient({ enclaveURL, configRepo });
await client.ready();
const containerDoc = client.getVerificationDocument();
console.error(`[container] ${containerDoc.configRepo} ${containerDoc.releaseTag || ''} ${String(containerDoc.releaseDigest).slice(0, 12)}... verified=${containerDoc.securityVerified}`);
if (!containerDoc.securityVerified) { console.error('The container enclave did not verify; nothing was sent.'); process.exit(1); }

// 2. Ask.
const identity = await (await client.fetch('/identity')).json();
console.error(`[container] signs as ${identity.signer}`);
console.error('[container] running the chain inside the enclave...');
const res = await client.fetch('/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENMAXXING_ASK_TOKEN}` },
  body: JSON.stringify({ question }),
});
const out = await res.json();
if (!res.ok) { console.error(`The enclave answered ${res.status}: ${out.error}`); process.exit(1); }
const { name } = out;

// 3. File it, then check it offline.
const recordsDir = path.join(ROOT, 'enclave', 'records');
const runDir = path.join(ROOT, 'docs', 'enclave', 'runs', name);
mkdirSync(recordsDir, { recursive: true });
mkdirSync(runDir, { recursive: true });
writeFileSync(path.join(recordsDir, `${name}.input.json`), out.input);
const signedPath = path.join(recordsDir, `${name}.signed.json`);
writeFileSync(signedPath, out.signed);
for (const [file, text] of Object.entries(out.files)) writeFileSync(path.join(runDir, file), text);
writeFileSync(path.join(runDir, 'container-verification.json'), `${JSON.stringify(containerDoc, null, 2)}\n`);

const signed = JSON.parse(out.signed);
const chain = signed.package.extensions?.[config.extensionKey] ?? {};
for (const ref of [chain.inference?.verificationDocument, chain.sourceRouter?.systemPrompt].filter(Boolean)) {
  const bytes = readFileSync(path.join(ROOT, 'docs', 'enclave', ref.url.slice(origin.length + 1)));
  if (`blob:sha256:${sha256(bytes)}` !== ref.ref) throw new Error(`${ref.url} does not match its signed hash`);
}
const CLI = path.join(ROOT, 'node_modules', '@typedstandards', 'cli', 'dist', 'bin', 'main.js');
const verified = spawnSync(process.execPath, [CLI, 'verify', '--input', signedPath], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
if (verified.status !== 0) throw new Error(`typedstandards verify: ${verified.stdout}${verified.stderr}`);

// 4. Bind the signing key to the attestation, when the Tinfoil CLI is installed.
const recordKeyHex = Buffer.from(signed.signature.publicKey, 'base64').toString('hex');
let keyBinding = 'not checked: the Tinfoil CLI is not installed';
const tinfoilCli = ['tinfoil', path.join(os.homedir(), '.local', 'bin', 'tinfoil'), '/usr/local/bin/tinfoil'].find((p) => p === 'tinfoil' ? spawnSync('which', ['tinfoil']).status === 0 : existsSync(p));
if (tinfoilCli) {
  const attestationPath = path.join(runDir, 'container-attestation.json');
  const a = spawnSync(tinfoilCli, ['attestation', 'verify', '-e', enclaveHost, '-r', configRepo, '-j', '-l', attestationPath], { encoding: 'utf8' });
  if (a.status === 0 && existsSync(attestationPath)) {
    const text = readFileSync(attestationPath, 'utf8');
    const found = text.toLowerCase().includes(recordKeyHex.toLowerCase());
    keyBinding = found
      ? 'ok: the record\'s signing key is in the container\'s attestation'
      : 'MISMATCH: the record\'s signing key is not in the container\'s attestation';
    if (!found) process.exitCode = 1;
  } else {
    keyBinding = `not checked: tinfoil attestation verify exited ${a.status}: ${(a.stderr || a.stdout).trim().slice(0, 300)}`;
  }
}

// 5. List it on the enclave host.
const hostPath = path.join(ROOT, 'enclave', 'host.json');
const host = JSON.parse(readFileSync(hostPath, 'utf8'));
host.records = host.records.filter((r) => r.name !== name);
host.records.push({ name, signed: `records/${name}.signed.json`, attestations: [], title: question.length > 90 ? `${question.slice(0, 87)}...` : question, extensions: { role: 'analysis' } });
writeFileSync(hostPath, `${JSON.stringify(host, null, 2)}\n`);
const policyPath = path.join(ROOT, 'enclave', 'host-policy.json');
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
policy.signer = signed.package.signer.identifier;
writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

const verifyLink = `https://typedstandards.org/verify?url=${encodeURIComponent(`${origin}/bundles/${name}.bundle.json`)}`;
writeFileSync(path.join(runDir, 'replay.json'), `${JSON.stringify({
  name,
  question,
  answer: out.run.answer,
  model: out.run.model,
  servedModels: out.run.servedModels,
  portal: out.run.portal,
  versions: out.run.versions,
  envelopeHash: signed.envelopeHash,
  signer: signed.package.signer.identifier,
  verifyLink,
  container: { url: enclaveURL, configRepo, releaseTag: containerDoc.releaseTag, releaseDigest: containerDoc.releaseDigest, keyBinding },
  files: {
    answer: `enclave/runs/${name}/answer.md`,
    verification: `enclave/runs/${name}/verification.json`,
    systemPrompt: `enclave/runs/${name}/system-prompt.md`,
    containerVerification: `enclave/runs/${name}/container-verification.json`,
    bundle: `enclave/bundles/${name}.bundle.json`,
  },
  events: out.events,
}, null, 2)}\n`);

console.log(`\n${out.run.answer.trim()}\n`);
console.log(`signed in the enclave by ${signed.package.signer.identifier}`);
console.log(`key binding: ${keyBinding}`);
console.log(`record:  enclave/records/${name}.signed.json (checked offline: ok)`);
console.log(`verify:  ${verifyLink}`);
