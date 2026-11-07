#!/usr/bin/env node
// npm run verify: what publish.yml checks, run locally, plus the served files.
// For each host (the site root, and /enclave once it has a record):
//   1. typedstandards-host build into a temporary directory;
//   2. typedstandards-host verify over it, offline, with the network blocked;
//   3. each run's served files (the Tinfoil verification document and the composed
//      prompt) against the SHA-256 the signed record carries for them.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadConfig } from './config.mjs';

const config = loadConfig();
const HOST = path.join(ROOT, 'node_modules', '@typedstandards', 'host-core', 'dist', 'bin', 'main.js');
const hosts = [
  { label: 'site', manifest: 'host.json', docs: 'docs', origin: config.origin },
  { label: 'enclave', manifest: 'enclave/host.json', docs: 'docs/enclave', origin: `${config.origin}/enclave` },
];

let failed = 0;
for (const h of hosts) {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, h.manifest), 'utf8'));
  if (manifest.records.length === 0) { console.log(`${h.label}: no records yet`); continue; }
  const out = mkdtempSync(path.join(os.tmpdir(), `openmaxxing-${h.label}-`));
  for (const cmd of ['build', 'verify']) {
    const r = spawnSync(process.execPath, [HOST, cmd, '--manifest', h.manifest, '--out', out], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  const base = path.dirname(path.join(ROOT, h.manifest));
  for (const record of manifest.records) {
    const signed = JSON.parse(readFileSync(path.join(base, record.signed), 'utf8'));
    const chain = signed.package.extensions?.[config.extensionKey];
    if (!chain) continue;
    for (const ref of [chain.inference?.verificationDocument, chain.sourceRouter?.systemPrompt].filter(Boolean)) {
      const rel = ref.url.slice(h.origin.length + 1);
      const bytes = readFileSync(path.join(ROOT, h.docs, rel));
      const ok = `blob:sha256:${createHash('sha256').update(bytes).digest('hex')}` === ref.ref && bytes.length === ref.size;
      if (!ok) failed += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${record.name}  ${h.docs}/${rel}`);
    }
  }
}
console.log(`served files: ${failed === 0 ? 'every file matches its signed hash' : `${failed} mismatched`}`);
process.exitCode = failed === 0 ? 0 : 1;
