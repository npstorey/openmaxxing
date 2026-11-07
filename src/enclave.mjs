#!/usr/bin/env node
// The chain inside a Tinfoil Container. The enclave generates the record-signing
// key (attested-keys in tinfoil-config.yml); it never leaves the enclave, and its
// public key is published in the enclave's attestation.
//
// Always:
//   GET  /health    liveness
//   GET  /identity  the did:key this enclave signs under, and its public key
//   POST /ask       {question} -> the signed record and its served files.
//                   Needs the bearer token in OPENMAXXING_ASK_TOKEN (a Tinfoil secret).
// With OPENMAXXING_WEB=1, the container also serves the demo page:
//   GET  /          docs/: the page, the diagram, the published runs
//   GET  /api/live  what this enclave runs, and how many public questions are left
//   POST /api/ask   a visitor's question, streamed as NDJSON events. Capped per
//                   process (OPENMAXXING_PUBLIC_CAP) and per visitor, so a public
//                   page cannot run up the operator's inference bill.
//   GET  /live/...  a Typed Standards host built in memory from the records this
//                   enclave signed for visitors: bundles, key registry, index, and
//                   each run's files. typedstandards.org verifies them from here.
import http from 'node:http';
import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { deriveKeyDerivedIdentifierFromKey } from '@typedstandards/produce-core';
import { buildHost } from '@typedstandards/host-core';
import { ROOT, loadConfig, packageVersion } from './config.mjs';
import { runChain, tinfoilClient } from './chain.mjs';
import { runName, writeRecord } from './record.mjs';

const PORT = Number(process.env.PORT || 8080);
const KEY_DIR = process.env.OPENMAXXING_KEY_DIR || '/run/tinfoil/keys/record-signing';
const OUT = process.env.OPENMAXXING_OUT || '/tmp/openmaxxing';
const WEB = process.env.OPENMAXXING_WEB === '1';
const PUBLIC_CAP = Number(process.env.OPENMAXXING_PUBLIC_CAP || 30);
const PER_VISITOR = 3; // questions per visitor per 10 minutes
const DOCS = path.join(ROOT, 'docs');
const config = loadConfig();
const origin = `${config.origin}/enclave`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.bpmn': 'application/xml', '.png': 'image/png', '.js': 'text/javascript' };

// The Ed25519 seed is the last 32 bytes of the PKCS#8 DER. It is set in this
// process's environment for the signing CLI's child process only, and never written.
const pem = readFileSync(path.join(KEY_DIR, 'private_key.pem'), 'utf8');
const der = createPrivateKey(pem).export({ format: 'der', type: 'pkcs8' });
const seed = der.subarray(der.length - 32);
process.env.TYPEDSTANDARDS_SIGNING_SEED_B64 = seed.toString('base64');
const signer = deriveKeyDerivedIdentifierFromKey(new Uint8Array(seed));
const publicKeySpkiHex = createPublicKey(pem).export({ format: 'der', type: 'spki' }).toString('hex');
const askToken = process.env.OPENMAXXING_ASK_TOKEN || '';
const versions = {
  tinfoil: packageVersion('tinfoil'),
  router: packageVersion('@typedstandards/civic-typed-router'),
  harness: packageVersion('@typedstandards/civic-typed-harness'),
  socrata: packageVersion('socrata-mcp-server'),
};

let busy = false;
let publicRuns = 0;
const visitors = new Map();
const liveRecords = [];
let liveHost = new Map();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  const want = Buffer.from(askToken);
  return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
}

async function readQuestion(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('too large');
  }
  return String(JSON.parse(raw).question || '').trim().slice(0, 500);
}

function publicOrigin(req) {
  return process.env.OPENMAXXING_PUBLIC_ORIGIN || `https://${req.headers.host}`;
}

function producer() {
  return {
    runtime: 'Tinfoil Container',
    configRepo: process.env.OPENMAXXING_ENCLAVE_REPO || null,
    signingKey: 'attested-keys/record-signing: Ed25519, generated inside the enclave; its public key is in the enclave attestation',
    publicKeySpkiHex,
  };
}

// Rebuild the in-memory host over every record signed for visitors.
function rebuildLiveHost(base) {
  const manifest = {
    origin: `${base}/live`,
    visibility: 'public',
    registry: { $comment: 'The key this Openmaxxing Tinfoil Container generated inside its enclave. Its public key is in the container\'s attestation. Not an endorsement by the Typed Standards specification or by typedstandards.org.' },
    index: { $comment: 'Records this container signed for visitors since it started. They live in memory and are gone on restart.' },
    records: liveRecords.map((r) => ({ name: r.name, signed: `records/${r.name}.signed.json`, attestations: [], title: r.title, extensions: { role: 'analysis' } })),
  };
  const files = new Map(liveRecords.map((r) => [`records/${r.name}.signed.json`, Buffer.from(r.signed)]));
  liveHost = buildHost(manifest, files).files;
}

function serveStatic(res, root, rel, cors) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) });
  createReadStream(file).pipe(res);
  return undefined;
}

async function runAndSign(question, base, emit) {
  const run = await runChain(question, config, emit);
  const name = runName(new Date(run.startedAt));
  const record = writeRecord(run, config, name, { outRoot: OUT, origin: base, updateHost: false, producer: producer() });
  return { run, name, record };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://enclave');
  const p = url.pathname;
  if (p === '/health') return send(res, 200, { ok: true });
  if (p === '/identity') {
    return send(res, 200, { signer, publicKeySpkiHex, key: 'attested-keys/record-signing (ed25519, generated in this enclave)', configRepo: process.env.OPENMAXXING_ENCLAVE_REPO || null, model: config.model, portal: config.portal });
  }

  // The operator's route, used by npm run ask:enclave.
  if (p === '/ask' && req.method === 'POST') {
    if (!authorized(req)) return send(res, 401, { error: 'bearer token required' });
    if (busy) return send(res, 409, { error: 'a run is in progress' });
    let question;
    try { question = await readQuestion(req); } catch { return send(res, 400, { error: 'POST {"question": "..."}' }); }
    if (!question) return send(res, 400, { error: 'no question' });
    busy = true;
    const started = Date.now();
    const events = [];
    try {
      const { run, name, record } = await runAndSign(question, origin, (e) => events.push({ t: Date.now() - started, ...e }));
      const read = (f) => readFileSync(f, 'utf8');
      send(res, 200, {
        name, signer, input: read(record.inputPath), signed: read(record.signedPath),
        files: Object.fromEntries(record.files.map((f) => [path.basename(f), read(f)])),
        run: { question, answer: run.answer, model: run.model, servedModels: run.servedModels, portal: run.socrata.portal, versions: run.versions },
        events,
      });
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error), events });
    } finally {
      busy = false;
    }
    return undefined;
  }

  if (!WEB) return send(res, 404, { error: 'not found' });

  if (p === '/api/live') {
    return send(res, 200, { live: publicRuns < PUBLIC_CAP, where: 'enclave', model: config.model, portal: config.portalDomain, versions, signer, configRepo: process.env.OPENMAXXING_ENCLAVE_REPO || null, remaining: Math.max(0, PUBLIC_CAP - publicRuns) });
  }

  if (p === '/api/ask') {
    if (req.method !== 'POST' || req.headers['x-openmaxxing'] !== '1') return send(res, 400, { error: 'POST JSON with X-Openmaxxing: 1' });
    if (publicRuns >= PUBLIC_CAP) return send(res, 429, { error: 'This demo has answered all the questions it will take today. The recorded runs are still here to replay and verify.' });
    const visitor = String(req.headers['x-forwarded-for'] || 'shared').split(',')[0].trim();
    const now = Date.now();
    const recent = (visitors.get(visitor) || []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= PER_VISITOR) return send(res, 429, { error: 'Three questions per visitor every ten minutes. Try again shortly.' });
    if (busy) return send(res, 409, { error: 'Another visitor\'s question is running. Try again in a minute.' });
    let question;
    try { question = await readQuestion(req); } catch { return send(res, 400, { error: 'bad JSON' }); }
    if (!question) return send(res, 400, { error: 'no question' });
    busy = true;
    publicRuns += 1;
    visitors.set(visitor, [...recent, now]);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const started = Date.now();
    const events = [];
    const emit = (event) => {
      const e = { t: Date.now() - started, ...event };
      events.push(e);
      res.write(`${JSON.stringify(e)}\n`);
    };
    try {
      const base = `${publicOrigin(req)}/live`;
      const { run, name, record } = await runAndSign(question, base, emit);
      const signed = readFileSync(record.signedPath, 'utf8');
      liveRecords.push({ name, signed, title: question.length > 90 ? `${question.slice(0, 87)}...` : question });
      rebuildLiveHost(publicOrigin(req));
      const pkg = JSON.parse(signed);
      const verifyLink = `https://typedstandards.org/verify?url=${encodeURIComponent(`${base}/bundles/${name}.bundle.json`)}`;
      res.write(`${JSON.stringify({ step: 'done', replay: {
        name, question, answer: run.answer, model: run.model, servedModels: run.servedModels, portal: run.socrata.portal, versions: run.versions,
        envelopeHash: pkg.envelopeHash, signer: pkg.package.signer.identifier, verifyLink, signedInEnclave: true,
        files: { answer: `/live/runs/${name}/answer.md`, verification: `/live/runs/${name}/verification.json`, systemPrompt: `/live/runs/${name}/system-prompt.md`, bundle: `/live/bundles/${name}.bundle.json` },
        events,
      } })}\n`);
    } catch (error) {
      res.write(`${JSON.stringify({ step: 'error', message: error instanceof Error ? error.message : String(error) })}\n`);
    } finally {
      busy = false;
      res.end();
    }
    return undefined;
  }

  if (p.startsWith('/live/')) {
    const rel = p.slice('/live/'.length);
    if (rel.startsWith('runs/')) return serveStatic(res, path.join(OUT, 'docs'), decodeURIComponent(rel), true);
    const bytes = liveHost.get(rel);
    if (!bytes) return send(res, 404, { error: 'not found' }, { 'Access-Control-Allow-Origin': '*' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(Buffer.from(bytes));
  }

  if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
  return serveStatic(res, DOCS, decodeURIComponent(p === '/' ? '/index.html' : p), false);
});

server.requestTimeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`openmaxxing enclave on :${PORT}${WEB ? ' with the demo page' : ''}, signing as ${signer}`);
});

// Warm up before the first visitor: attest the model router once, and wait until the
// egress allowlist lets the portal through (the first calls from v0.0.1 timed out).
tinfoilClient(config).then(
  ({ verificationDocument }) => console.log(`model router attested: verified=${verificationDocument.securityVerified}`),
  (error) => console.error(`model router attestation failed; the first run will retry: ${error.message}`),
);
(async () => {
  const probe = `${config.portal}/resource/erm2-nwe9.json?$limit=1`;
  for (let i = 0; i < 30; i += 1) {
    try {
      const r = await fetch(probe, { headers: process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : {}, signal: AbortSignal.timeout(8000) });
      if (r.ok) { console.log(`portal reachable after ${i + 1} tries`); return; }
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  console.error('portal still unreachable after 5 minutes');
})();
