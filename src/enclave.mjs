#!/usr/bin/env node
// The chain inside a Tinfoil Container. The enclave generates the record-signing
// key (attested-keys in tinfoil-config.yml); it never leaves the enclave, and its
// public key is published in the enclave's attestation. A caller verifies the
// container's enclave with Tinfoil's SecureClient before sending a question.
//   GET  /health    liveness
//   GET  /identity  the did:key this enclave signs under, and its public key
//   POST /ask       {question} -> the signed record and its served files
// /ask needs the bearer token in OPENMAXXING_ASK_TOKEN, a Tinfoil secret, so a
// stranger who finds the URL cannot spend the operator's inference credits.
import http from 'node:http';
import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveKeyDerivedIdentifierFromKey } from '@typedstandards/produce-core';
import { loadConfig } from './config.mjs';
import { runChain } from './chain.mjs';
import { runName, writeRecord } from './record.mjs';

const PORT = Number(process.env.PORT || 8080);
const KEY_DIR = process.env.OPENMAXXING_KEY_DIR || '/run/tinfoil/keys/record-signing';
const OUT = process.env.OPENMAXXING_OUT || '/tmp/openmaxxing';
const config = loadConfig();
const origin = `${config.origin}/enclave`;

// The Ed25519 seed is the last 32 bytes of the PKCS#8 DER. It is set in this
// process's environment for the signing CLI's child process only, and never written.
const pem = readFileSync(path.join(KEY_DIR, 'private_key.pem'), 'utf8');
const der = createPrivateKey(pem).export({ format: 'der', type: 'pkcs8' });
const seed = der.subarray(der.length - 32);
process.env.TYPEDSTANDARDS_SIGNING_SEED_B64 = seed.toString('base64');
const signer = deriveKeyDerivedIdentifierFromKey(new Uint8Array(seed));
const publicKeySpkiHex = createPublicKey(pem).export({ format: 'der', type: 'spki' }).toString('hex');
const askToken = process.env.OPENMAXXING_ASK_TOKEN || '';

let busy = false;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  const want = Buffer.from(askToken);
  return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://enclave');
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  if (url.pathname === '/identity') {
    return send(res, 200, {
      signer,
      publicKeySpkiHex,
      key: 'attested-keys/record-signing (ed25519, generated in this enclave)',
      configRepo: process.env.OPENMAXXING_ENCLAVE_REPO || null,
      model: config.model,
      portal: config.portal,
    });
  }
  if (url.pathname !== '/ask' || req.method !== 'POST') return send(res, 404, { error: 'not found' });
  if (!authorized(req)) return send(res, 401, { error: 'bearer token required' });
  if (busy) return send(res, 409, { error: 'a run is in progress' });

  let question;
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 10_000) throw new Error('too large');
    }
    question = String(JSON.parse(raw).question || '').trim().slice(0, 500);
  } catch {
    return send(res, 400, { error: 'POST {"question": "..."}' });
  }
  if (!question) return send(res, 400, { error: 'no question' });

  busy = true;
  const started = Date.now();
  const events = [];
  try {
    const run = await runChain(question, config, (e) => events.push({ t: Date.now() - started, ...e }));
    const name = runName(new Date(run.startedAt));
    const producer = {
      runtime: 'Tinfoil Container',
      configRepo: process.env.OPENMAXXING_ENCLAVE_REPO || null,
      signingKey: 'attested-keys/record-signing: Ed25519, generated inside the enclave; its public key is in the enclave attestation',
      publicKeySpkiHex,
    };
    const record = writeRecord(run, config, name, { outRoot: OUT, origin, updateHost: false, producer });
    const read = (p) => readFileSync(p, 'utf8');
    const files = Object.fromEntries(record.files.map((p) => [path.basename(p), read(p)]));
    send(res, 200, {
      name,
      signer,
      input: read(record.inputPath),
      signed: read(record.signedPath),
      files,
      run: { question, answer: run.answer, model: run.model, servedModels: run.servedModels, portal: run.socrata.portal, versions: run.versions },
      events,
    });
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error), events });
  } finally {
    busy = false;
  }
  return undefined;
});

server.requestTimeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`openmaxxing enclave on :${PORT}, signing as ${signer}`);
});
