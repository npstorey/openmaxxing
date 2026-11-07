// The chain: the source router composes the tools and the prompt, the model runs
// in a Tinfoil enclave behind Tinfoil's confidential model router, each tool call
// the model makes is resolved through the source router's dispatch map and sent
// to socrata-mcp-server, and the harness's TraceBuilder records every step.
import { TinfoilAI } from 'tinfoil';
import { civicRouter, readMcpEnv } from '@typedstandards/civic-typed-router';
import { TraceBuilder, hash } from '@typedstandards/civic-typed-harness';
import { connectSocrata } from './socrata.mjs';
import { packageVersion } from './config.mjs';

const SELECTION = ['socrata'];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return null;
  }
}

// One entry of the record's queries[]: produce-core's EnvelopeQuery shape.
function queryOf(calledName, resolution, args, duration) {
  return {
    tool: calledName,
    operationType: resolution.ok ? resolution.upstreamName : 'unknown',
    arguments: args,
    ...(args.dataset_id ? { datasetId: String(args.dataset_id) } : {}),
    ...(args.domain ? { portal: String(args.domain) } : {}),
    duration_ms: duration,
  };
}

/**
 * Run one question through the chain.
 * @param {string} question
 * @param {object} config  loadConfig()
 * @param {(event: object) => void} [emit]  progress events, for the CLI and the demo page
 */
export async function runChain(question, config, emit = () => {}) {
  const startedAt = new Date();
  const trace = new TraceBuilder(config.trace);
  const socrata = await connectSocrata(config.portal);
  emit({ step: 'source', status: 'connected', server: socrata.address, portal: config.portal });

  try {
    // Layer 3a: the source router. One source, Socrata, locked to one portal.
    const configured = readMcpEnv({ SOCRATA_MCP_URL: socrata.address });
    const portal = config.portalDomain;
    const tools = civicRouter.aliasedOfferedMcpTools(
      civicRouter.aliasedMcpToolsFor(portal),
      configured,
      SELECTION,
    );
    const sourcesOffered = civicRouter.sourcesOffered(configured, SELECTION);
    const mcpServers = [{ url: socrata.address, name: 'socrata' }];

    trace.startRoot('analysis', {
      'analysis.prompt_hash': hash(question),
      'analysis.model': config.model,
      'analysis.portal': portal,
      'analysis.asserted_date': today(),
      'analysis.mcp_servers': JSON.stringify(mcpServers),
      'analysis.tool_definitions': JSON.stringify(tools),
      'analysis.sources_offered': JSON.stringify(sourcesOffered),
    });

    const skillSpan = trace.startSpan('skill_fetch');
    const composed = await civicRouter.aliasedBuildSystemPrompt({
      portal,
      configured,
      today: today(),
      publicationHost: null,
      fetchPrompt: (name, args) => socrata.fetchPrompt(name, args),
      fetchInstructions: (sourceId) => (sourceId === 'socrata' ? socrata.fetchInstructions() : null),
      selection: SELECTION,
    });
    const systemPrompt = civicRouter.aliasedWithPortalLockGuidance(composed, portal, configured, SELECTION);
    const systemPromptHash = hash(systemPrompt);
    trace.endSpan(skillSpan, {
      'skill.text_hash': systemPromptHash,
      'skill.mcp_server_url': socrata.address,
    });
    emit({
      step: 'router',
      tools: tools.map((t) => t.function.name),
      promptChars: systemPrompt.length,
      promptHash: systemPromptHash,
    });

    // Layers 3b, 4 and 5: Tinfoil verifies the model router's enclave before
    // anything is sent. The router verifies the model enclave in turn.
    const client = new TinfoilAI({ apiKey: process.env.TINFOIL_API_KEY });
    await client.ready();
    const verificationDocument = await client.getVerificationDocument();
    emit({
      step: 'attestation',
      securityVerified: verificationDocument.securityVerified,
      configRepo: verificationDocument.configRepo,
      enclaveHost: verificationDocument.enclaveHost,
      releaseDigest: verificationDocument.releaseDigest,
      releaseTag: verificationDocument.releaseTag,
      document: verificationDocument,
    });
    if (!verificationDocument.securityVerified) {
      throw new Error('Tinfoil verification did not pass; nothing was sent');
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ];
    const toolCalls = [];
    const queries = [];
    const usage = { promptTokens: 0, completionTokens: 0 };
    const servedModels = new Set();
    let answer = null;

    for (let i = 0; i <= config.maxIterations; i += 1) {
      const lastTurn = i === config.maxIterations;
      const llmSpan = trace.startSpan('llm_inference', trace.rootSpanId, {
        'gen_ai.system': 'tinfoil',
        'gen_ai.request.model': config.model,
        'gen_ai.system_prompt_hash': systemPromptHash,
        'gen_ai.inference_index': i,
      });
      emit({ step: 'model', status: 'request', index: i });
      const response = await client.chat.completions.create({
        model: config.model,
        messages,
        ...(lastTurn ? {} : { tools, tool_choice: 'auto' }),
      });
      usage.promptTokens += response.usage?.prompt_tokens ?? 0;
      usage.completionTokens += response.usage?.completion_tokens ?? 0;
      if (response.model) servedModels.add(response.model);
      trace.endSpan(llmSpan, {
        'gen_ai.response.model': response.model ?? '',
        'gen_ai.usage.input_tokens': response.usage?.prompt_tokens ?? 0,
        'gen_ai.usage.output_tokens': response.usage?.completion_tokens ?? 0,
      });

      const message = response.choices[0]?.message;
      const calls = message?.tool_calls ?? [];
      if (calls.length === 0) {
        answer = message?.content ?? '';
        break;
      }
      messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });

      for (const call of calls) {
        const calledName = call.function?.name ?? '';
        const args = parseArgs(call.function?.arguments);
        const resolution = civicRouter.resolveCalledName(calledName, configured, SELECTION);
        const span = trace.startSpan('mcp_tool_call', trace.rootSpanId, {
          'tool.name': calledName,
          'tool.operation_type': resolution.ok ? resolution.upstreamName : 'unknown',
          'tool.arguments': JSON.stringify(args ?? {}),
          'mcp.source': resolution.ok ? resolution.sourceId : 'unknown',
          ...(args?.dataset_id ? { 'tool.dataset_id': String(args.dataset_id) } : {}),
          ...(args?.domain ? { 'tool.portal_domain': String(args.domain) } : {}),
          ...(resolution.ok
            ? {
                'tool.upstream_name': resolution.upstreamName,
                'mcp.alias': resolution.alias,
                'mcp.server.id': resolution.sourceId,
              }
            : {}),
        });
        const started = Date.now();
        const entry = { name: calledName, args: args ?? {} };
        let content;
        emit({ step: 'tool', status: 'call', name: calledName, upstream: resolution.ok ? resolution.upstreamName : null, args });
        try {
          if (!resolution.ok) throw new Error(resolution.message);
          if (args === null) throw new Error('tool arguments were not valid JSON');
          const result = await socrata.callTool(resolution.upstreamName, args);
          if (result.isError) throw new Error(result.text.slice(0, 500));
          const duration = Date.now() - started;
          trace.endSpan(span, {
            'tool.response_hash': hash(result.text),
            'tool.response_size_bytes': Buffer.byteLength(result.text),
            'tool.duration_ms': duration,
          });
          content = result.text.slice(0, config.maxToolResultChars);
          emit({ step: 'tool', status: 'result', name: calledName, bytes: Buffer.byteLength(result.text), ms: duration });
          queries.push(queryOf(calledName, resolution, args, duration));
        } catch (error) {
          const duration = Date.now() - started;
          entry.failed = true;
          entry.failureKind = 'tool-error';
          trace.endSpan(span, { error: true, 'error.kind': 'tool-error', 'tool.duration_ms': duration });
          content = `Error: ${error instanceof Error ? error.message : String(error)}`;
          emit({ step: 'tool', status: 'error', name: calledName, message: content.slice(0, 200) });
          queries.push({ ...queryOf(calledName, resolution, args ?? {}, duration), failed: true, failureKind: 'tool-error' });
        }
        toolCalls.push(entry);
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }

    const synthesis = trace.startSpan('synthesis', trace.rootSpanId);
    trace.endSpan(synthesis, { 'output.hash': hash(answer ?? ''), 'output.length': (answer ?? '').length });
    trace.endRoot();
    emit({ step: 'answer', chars: (answer ?? '').length });

    return {
      question,
      answer: answer ?? '',
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      trace: trace.finalize(),
      toolCalls,
      queries,
      usage,
      model: config.model,
      servedModels: [...servedModels],
      systemPrompt,
      systemPromptHash,
      tools,
      socrata: { address: socrata.address, version: socrata.version, portal: config.portal },
      verificationDocument,
      versions: {
        tinfoil: packageVersion('tinfoil'),
        router: packageVersion('@typedstandards/civic-typed-router'),
        harness: packageVersion('@typedstandards/civic-typed-harness'),
        socrata: socrata.version,
      },
    };
  } finally {
    await socrata.close().catch(() => {});
  }
}
