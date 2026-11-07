#!/usr/bin/env node
// npm run serve: the demo page in live mode, on this machine only.
//   op run --env-file=op.env -- npm run serve
// Serves docs/ and the records this machine signs, and runs the chain for a question
// the page posts. It listens on 127.0.0.1, answers only requests whose Host is
// localhost, and requires a custom header, so another site's page cannot drive it.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, packageVersion } from './config.mjs';
import { runChain, tinfoilClient } from './chain.mjs';
import { runName, writeRecord } from './record.mjs';
import { writeReplay } from './replay.mjs';

const PORT = Number(process.env.PORT || 8787);
const DOCS = path.join(ROOT, 'docs');
const config = loadConfig();
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.bpmn': 'application/xml', '.js': 'text/javascript' };
const hasKeys = Boolean(process.env.TINFOIL_API_KEY && process.env.TYPEDSTANDARDS_SIGNING_SEED_B64);
let busy = false;

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('request too large');
  }
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1'].includes(host)) return send(res, 403, { error: 'localhost only' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/live') {
    return send(res, 200, {
      live: hasKeys,
      model: config.model,
      portal: config.portalDomain,
      versions: {
        tinfoil: packageVersion('tinfoil'),
        router: packageVersion('@typedstandards/civic-typed-router'),
        harness: packageVersion('@typedstandards/civic-typed-harness'),
        socrata: packageVersion('socrata-mcp-server'),
      },
    });
  }

  if (url.pathname === '/api/ask') {
    if (req.method !== 'POST' || req.headers['x-openmaxxing'] !== '1' || !String(req.headers['content-type']).startsWith('application/json')) {
      return send(res, 400, { error: 'POST JSON with X-Openmaxxing: 1' });
    }
    if (!hasKeys) return send(res, 503, { error: 'run through op run --env-file=op.env' });
    if (busy) return send(res, 409, { error: 'a run is in progress' });
    let question;
    try {
      question = String((await readJson(req)).question || '').trim().slice(0, 500);
    } catch {
      return send(res, 400, { error: 'bad JSON' });
    }
    if (!question) return send(res, 400, { error: 'no question' });
    busy = true;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const started = Date.now();
    const events = [];
    const emit = (event) => {
      const e = { t: Date.now() - started, ...event };
      events.push(e);
      res.write(`${JSON.stringify(e)}\n`);
    };
    try {
      const run = await runChain(question, config, emit);
      const name = runName(new Date(run.startedAt));
      const record = writeRecord(run, config, name);
      const verifyLink = `https://typedstandards.org/verify?url=${encodeURIComponent(`${config.origin}/bundles/${name}.bundle.json`)}`;
      const file = writeReplay(name, run, record, events, verifyLink);
      const replay = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
      res.write(`${JSON.stringify({ step: 'done', replay })}\n`);
      console.log(`signed records/${name}.signed.json; commit and push to publish: ${verifyLink}`);
    } catch (error) {
      res.write(`${JSON.stringify({ step: 'error', message: error instanceof Error ? error.message : String(error) })}\n`);
    } finally {
      busy = false;
      res.end();
    }
    return undefined;
  }

  // Static files from docs/.
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(DOCS, rel));
  if (!file.startsWith(DOCS + path.sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
  return undefined;
});

if (hasKeys) {
  tinfoilClient(config).then(
    ({ verificationDocument }) => console.log(`model router attested in advance: verified=${verificationDocument.securityVerified}`),
    (error) => console.error(`advance attestation failed; the first run will retry: ${error.message}`),
  );
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Openmaxxing demo: http://localhost:${PORT}/  (${hasKeys ? 'live mode' : 'replay only: no keys in the environment'})`);
});
