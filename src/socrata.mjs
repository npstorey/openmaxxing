// The open-data layer: socrata-mcp-server, run as a child process over stdio.
// The child gets only what it needs: the portal and, if set, the Socrata app
// token. It never sees the Tinfoil key or the signing seed.
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, packageVersion } from './config.mjs';

export async function connectSocrata(portal) {
  const version = packageVersion('socrata-mcp-server');
  const env = { PATH: process.env.PATH ?? '', DATA_PORTAL_URL: portal };
  if (process.env.SOCRATA_APP_TOKEN) env.SOCRATA_APP_TOKEN = process.env.SOCRATA_APP_TOKEN;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'node_modules', 'socrata-mcp-server', 'dist', 'index.js'), '--stdio'],
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'openmaxxing', version: '0.1.0' });
  await client.connect(transport);
  return {
    client,
    // A package URL names what ran: there is no network address for a stdio server.
    address: `pkg:npm/socrata-mcp-server@${version}`,
    version,
    async fetchPrompt(name, args) {
      const result = await client.getPrompt({ name, arguments: args });
      return result.messages
        .map((m) => (m.content?.type === 'text' ? m.content.text : ''))
        .join('\n');
    },
    fetchInstructions() {
      return client.getInstructions() ?? null;
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
        .join('\n');
      return { text, isError: Boolean(result.isError) };
    },
    close: () => client.close(),
  };
}
