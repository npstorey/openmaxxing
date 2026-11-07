// Reads openmaxxing.config.json. Environment variables override the two values a
// user is most likely to change for one run: the portal and the model.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  const config = JSON.parse(readFileSync(path.join(ROOT, 'openmaxxing.config.json'), 'utf8'));
  delete config.$comment;
  if (process.env.OPENMAXXING_PORTAL) config.portal = process.env.OPENMAXXING_PORTAL;
  if (process.env.OPENMAXXING_MODEL) config.model = process.env.OPENMAXXING_MODEL;
  if (config.model === 'auto') throw new Error('model "auto" lets the router choose; the record must name the model');
  config.portalDomain = new URL(config.portal).host;
  return config;
}

export function packageVersion(name) {
  return JSON.parse(readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
}
