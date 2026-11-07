#!/usr/bin/env node
// npm run verify: what publish.yml checks, run locally, plus the served files.
//   1. typedstandards-host build into a temporary directory, from host.json and records/;
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
const out = mkdtempSync(path.join(os.tmpdir(), 'openmaxxing-site-'));

function host(args) {
  const r = spawnSync(process.execPath, [HOST, ...args, '--out', out], { cwd: ROOT, encoding: 'utf8' });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

host(['build']);
host(['verify']);

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'host.json'), 'utf8'));
let failed = 0;
for (const record of manifest.records) {
  const signed = JSON.parse(readFileSync(path.join(ROOT, record.signed), 'utf8'));
  const chain = signed.package.extensions?.[config.extensionKey];
  if (!chain) continue;
  const refs = [chain.inference?.verificationDocument, chain.sourceRouter?.systemPrompt].filter(Boolean);
  for (const ref of refs) {
    const rel = ref.url.slice(config.origin.length + 1);
    const bytes = readFileSync(path.join(ROOT, 'docs', rel));
    const ok = `blob:sha256:${createHash('sha256').update(bytes).digest('hex')}` === ref.ref && bytes.length === ref.size;
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${record.name}  ${rel}`);
  }
}
console.log(`served files: ${failed === 0 ? 'every file matches its signed hash' : `${failed} mismatched`}`);
process.exitCode = failed === 0 ? 0 : 1;
