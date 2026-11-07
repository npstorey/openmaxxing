// The record: the harness derives every domain field from the run's trace, and
// the Typed Standards CLI assembles, signs and checks the envelope. The CLI is
// spawned with only PATH and the signing seed in its environment.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildDataSources,
  buildProvenanceGraph,
  deriveDatHereEnvelopeFields,
  extractRunAttributes,
  hash,
} from '@typedstandards/civic-typed-harness';
import { ROOT, packageVersion } from './config.mjs';

const CLI = path.join(ROOT, 'node_modules', '@typedstandards', 'cli', 'dist', 'bin', 'main.js');

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Write a file under docs/runs/<name>/ and return a BlobRef to its served URL. */
function servedFile(config, name, file, text, contentType) {
  const dir = path.join(ROOT, 'docs', 'runs', name);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(text, 'utf8');
  writeFileSync(path.join(dir, file), bytes);
  return {
    path: path.join(dir, file),
    ref: {
      ref: `blob:sha256:${sha256Hex(bytes)}`,
      url: `${config.origin}/runs/${name}/${file}`,
      contentType,
      size: bytes.length,
    },
  };
}

export function runName(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `run-${iso.toLowerCase()}`;
}

function cli(args) {
  const env = { PATH: process.env.PATH ?? '' };
  if (process.env.TYPEDSTANDARDS_SIGNING_SEED_B64) {
    env.TYPEDSTANDARDS_SIGNING_SEED_B64 = process.env.TYPEDSTANDARDS_SIGNING_SEED_B64;
  }
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result;
}

/**
 * Build, sign and check the record for one run. Writes:
 *   docs/runs/<name>/answer.md          the answer, signed inline (raw-bytes/v1)
 *   docs/runs/<name>/verification.json  Tinfoil's verification document, a referenced file
 *   docs/runs/<name>/system-prompt.md   the composed prompt, a referenced file
 *   records/<name>.input.json           the envelope input
 *   records/<name>.signed.json          what the CLI's sign printed
 */
export function writeRecord(run, config, name = runName(new Date(run.startedAt))) {
  const now = new Date().toISOString();
  const packageId = randomUUID();

  const answer = servedFile(config, name, 'answer.md', run.answer.endsWith('\n') ? run.answer : `${run.answer}\n`, 'text/markdown');
  const verification = servedFile(
    config,
    name,
    'verification.json',
    `${JSON.stringify(run.verificationDocument, null, 2)}\n`,
    'application/json',
  );
  const prompt = servedFile(config, name, 'system-prompt.md', run.systemPrompt, 'text/markdown');

  const registry = {
    socrata: {
      displayName: 'Socrata',
      agentTitle: `socrata-mcp-server ${run.socrata.version}`,
      serverUrl: run.socrata.address,
      catalogType: 'socrata',
    },
  };
  const trace = run.trace;
  const attributes = extractRunAttributes(trace);
  const dataSources = buildDataSources(run.toolCalls, trace, undefined, now, { registry });
  const provenance = buildProvenanceGraph(
    trace,
    {
      packageId,
      promptHash: hash(run.question),
      promptText: run.question,
      outputText: readFileSync(answer.path, 'utf8'),
      model: run.model,
    },
    {
      platformAgent: config.platformAgent,
      sourceRegistry: registry,
      modelAgentDescription: `${run.model}, open weights under Apache-2.0, run by Tinfoil in a hardware enclave behind its confidential model router`,
    },
  );

  const doc = run.verificationDocument;
  const chain = {
    sourceRouter: {
      package: `@typedstandards/civic-typed-router@${run.versions.router}`,
      selection: ['socrata'],
      tools: run.tools.map((t) => t.function.name),
      systemPromptHash: run.systemPromptHash,
      systemPrompt: prompt.ref,
    },
    harness: `@typedstandards/civic-typed-harness@${run.versions.harness}`,
    modelRouter: {
      configRepo: doc.configRepo,
      releaseTag: doc.releaseTag,
      releaseDigest: doc.releaseDigest,
      enclaveHost: doc.enclaveHost,
      codeFingerprint: doc.codeFingerprint,
      enclaveFingerprint: doc.enclaveFingerprint,
      securityVerified: doc.securityVerified,
      verifiedAt: doc.verifiedAt,
      verifier: doc.verifier,
    },
    inference: {
      provider: 'Tinfoil',
      host: config.inferenceHost,
      sdk: `tinfoil@${run.versions.tinfoil}`,
      model: run.model,
      modelLicense: 'Apache-2.0',
      servedModels: run.servedModels,
      verificationDocument: verification.ref,
    },
    data: {
      server: run.socrata.address,
      transport: 'stdio',
      portal: run.socrata.portal,
    },
  };

  const datHere = deriveDatHereEnvelopeFields(
    {
      model: run.model,
      producerProfile: config.producerProfile,
      skillMcpServerUrl: run.socrata.address,
      runMcpServers: attributes.runMcpServers,
      toolDefinitions: attributes.toolDefinitions,
      assertedDate: attributes.assertedDate,
      sourcesOffered: attributes.sourcesOffered,
      extensions: { [config.extensionKey]: chain },
    },
    { host: config.environmentHost },
  );

  const totalTokens = run.usage.promptTokens + run.usage.completionTokens;
  const input = {
    type: 'content/analysis/v1',
    packageId,
    createdAt: now,
    prompt: run.question,
    promptVisibility: 'full_text',
    queries: run.queries,
    dataSources,
    cost: {
      ...(run.usage.promptTokens ? { promptTokens: run.usage.promptTokens } : {}),
      ...(run.usage.completionTokens ? { completionTokens: run.usage.completionTokens } : {}),
      ...(totalTokens ? { totalTokens } : {}),
      model: run.model,
      durationMs: run.durationMs,
    },
    skillMetadata: {
      systemPromptHash: run.systemPromptHash,
      mcpServerUrl: run.socrata.address,
    },
    trace,
    captureMethod: config.captureMethod,
    producerProfile: datHere.producerProfile,
    ...(datHere.summary ? { summary: datHere.summary } : {}),
    signer: config.signer,
    provenance,
    extensions: datHere.extensions,
  };

  mkdirSync(path.join(ROOT, 'records'), { recursive: true });
  const inputPath = path.join(ROOT, 'records', `${name}.input.json`);
  const signedPath = path.join(ROOT, 'records', `${name}.signed.json`);
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  const signed = cli(['sign', '--input', inputPath, '--output-file', answer.path]);
  if (signed.status !== 0) {
    throw new Error(`typedstandards sign exited ${signed.status}: ${signed.stderr.trim()}`);
  }
  writeFileSync(signedPath, signed.stdout.endsWith('\n') ? signed.stdout : `${signed.stdout}\n`);

  // The served files' references sit in extensions. Check #9 scans only output,
  // trace and skillMetadata.skillText, and the host's offline verify fails on any
  // fetch, so no reference goes in those three. Their signed hashes are checked here.
  const verified = cli(['verify', '--input', signedPath]);
  if (verified.status !== 0) {
    throw new Error(`typedstandards verify exited ${verified.status}: ${verified.stdout}${verified.stderr}`);
  }
  for (const file of [verification, prompt]) {
    const served = `blob:sha256:${sha256Hex(readFileSync(file.path))}`;
    if (served !== file.ref.ref) throw new Error(`${file.path} does not match its signed hash`);
  }

  addToHost(name, signedPath, run.question);
  return { name, inputPath, signedPath, files: [answer.path, verification.path, prompt.path], verify: JSON.parse(verified.stdout) };
}

/** Add the record to host.json, and name the signer in host-policy.json. */
function addToHost(name, signedPath, question) {
  const hostPath = path.join(ROOT, 'host.json');
  const host = JSON.parse(readFileSync(hostPath, 'utf8'));
  host.records = host.records.filter((r) => r.name !== name);
  host.records.push({
    name,
    signed: `records/${name}.signed.json`,
    attestations: [],
    title: question.length > 90 ? `${question.slice(0, 87)}...` : question,
    extensions: { role: 'analysis' },
  });
  writeFileSync(hostPath, `${JSON.stringify(host, null, 2)}\n`);

  const signer = JSON.parse(readFileSync(signedPath, 'utf8')).package.signer.identifier;
  const policyPath = path.join(ROOT, 'host-policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  if (policy.signer !== signer) {
    policy.signer = signer;
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  }
}

export function cliVersion() {
  return packageVersion('@typedstandards/cli');
}
