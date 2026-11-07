// The replay: what the demo page plays back step by step in public mode. It holds
// only what the record and its served files already carry, plus the timing.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

export function writeReplay(name, run, record, events, verifyLink) {
  const signed = JSON.parse(readFileSync(record.signedPath, 'utf8'));
  const replay = {
    name,
    question: run.question,
    answer: run.answer,
    model: run.model,
    servedModels: run.servedModels,
    portal: run.socrata.portal,
    versions: run.versions,
    envelopeHash: signed.envelopeHash,
    signer: signed.package.signer.identifier,
    verifyLink,
    files: {
      answer: `runs/${name}/answer.md`,
      verification: `runs/${name}/verification.json`,
      systemPrompt: `runs/${name}/system-prompt.md`,
      bundle: `bundles/${name}.bundle.json`,
    },
    events,
  };
  const file = path.join(ROOT, 'docs', 'runs', name, 'replay.json');
  writeFileSync(file, `${JSON.stringify(replay, null, 2)}\n`);
  writeFileSync(path.join(ROOT, 'docs', 'runs', 'latest.json'), `${JSON.stringify({ name }, null, 2)}\n`);
  return file;
}
