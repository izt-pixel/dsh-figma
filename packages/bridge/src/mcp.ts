#!/usr/bin/env node
/**
 * Bridge entry point: MCP over stdio on one side, loopback HTTP for the Figma
 * plugin on the other.
 *
 * Startup policy: a failure to bind the HTTP port does NOT abort the process.
 * If it did, DSH would simply lose the tools and the user would see nothing.
 * Instead the tools stay registered and every call returns the bind error
 * verbatim, while a background retry keeps trying to recover — so the common
 * "two DSH sessions, one port" mistake reads as a clear message in the chat and
 * heals itself once the other session goes away.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  BridgeErrorCode,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_COMMAND_TIMEOUT_MS,
  POLL_PATH,
  commandError,
  failedResult,
  type CommandError,
  type CommandResult,
} from '@dsh-figma/protocol';
import { BridgeFailure, FigmaBridge } from './bridge.js';
import { TOOLS, findTool } from './tools.js';
import { contentForResult } from './render.js';
import { describeError, log } from './log.js';

const SERVER_NAME = 'dsh-figma-bridge';
const SERVER_VERSION = '0.1.0';

/**
 * `--standalone` (or `FIGMA_BRIDGE_STANDALONE=1`) serves the HTTP endpoint
 * without wiring up MCP over stdio.
 *
 * This exists so the Figma side can be exercised without restarting DSH, and so
 * the bridge can be run by hand when debugging. It is not the normal path: DSH
 * spawns this binary as an MCP server and owns its lifetime.
 */
function isStandalone(): boolean {
  return process.argv.includes('--standalone') || process.env['FIGMA_BRIDGE_STANDALONE'] === '1';
}

/** Retry cadence for a failed port bind. */
const BIND_RETRY_MS = 10_000;

function readPort(): number {
  const raw = process.env['FIGMA_BRIDGE_PORT'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_BRIDGE_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    log('warn', `ignoring invalid FIGMA_BRIDGE_PORT=${raw}; using ${DEFAULT_BRIDGE_PORT}`);
    return DEFAULT_BRIDGE_PORT;
  }
  return parsed;
}

function readTimeout(): number {
  const raw = process.env['FIGMA_BRIDGE_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_COMMAND_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.floor(parsed);
}

const bridge = new FigmaBridge({
  port: readPort(),
  host: process.env['FIGMA_BRIDGE_HOST'] ?? DEFAULT_BRIDGE_HOST,
  commandTimeoutMs: readTimeout(),
});

let bindFailure: CommandError | null = null;
let retryTimer: NodeJS.Timeout | null = null;

async function tryBind(): Promise<CommandError | null> {
  try {
    await bridge.listen();
    bindFailure = null;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    return null;
  } catch (error) {
    const detail =
      error instanceof BridgeFailure
        ? error.detail
        : commandError(BridgeErrorCode.BridgeError, `Unexpected bind failure: ${describeError(error)}`);
    bindFailure = detail;
    return detail;
  }
}

function scheduleBindRetry(): void {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void (async () => {
      const recovered = await tryBind();
      if (recovered === null) {
        log('info', `bridge recovered on port ${bridge.address.port}`);
      } else {
        scheduleBindRetry();
      }
    })();
  }, BIND_RETRY_MS);
  retryTimer.unref();
}

/** Refuse to talk to a bridge that never managed to listen. */
async function dispatch(name: string, args: Record<string, unknown>): Promise<CommandResult> {
  if (bindFailure !== null) {
    const recovered = await tryBind();
    if (recovered !== null) {
      return failedResult('', recovered);
    }
  }
  return await bridge.command(name, args);
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const tool = findTool(toolName);

  if (tool === undefined) {
    const available = TOOLS.map((entry) => entry.name).join(', ');
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `Unknown Figma tool "${toolName}". Available tools: ${available}.`,
        },
      ],
    };
  }

  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const result = await dispatch(toolName, args);
  const content = contentForResult(toolName, result);

  // Only a genuinely failed command sets isError. A screenshot that produced no
  // usable image already explains itself in its content, and marking it as a
  // tool error would make the model retry instead of reading the reason.
  return result.ok ? { content } : { isError: true, content };
});

async function main(): Promise<void> {
  const standalone = isStandalone();
  const failure = await tryBind();
  if (failure !== null) {
    log('error', 'bridge could not bind; tools will report this until it recovers', failure);
    scheduleBindRetry();
  }

  let shuttingDown = false;
  const shutdown = (reason: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `shutting down: ${reason}`);
    void bridge.close().then(() => process.exit(exitCode));
  };

  if (standalone) {
    // HTTP only: stdin is irrelevant here, so the EOF hook below is deliberately
    // NOT installed — otherwise a shell with a closed stdin would kill the bridge
    // the instant it started.
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    log('info', `${SERVER_NAME} v${SERVER_VERSION} serving HTTP only (standalone)`, {
      addresses: bridge.addresses,
      poll: POLL_PATH,
    });
    return;
  }

  // The SDK's StdioServerTransport only subscribes to stdin `data` and `error`
  // — it never observes EOF — so `server.onclose` alone does NOT fire when the
  // MCP client goes away. And because our HTTP server holds the event loop open,
  // the process would then live forever, orphaning one bridge per DSH session.
  // Listening for `end` here is what actually makes shutdown happen.
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  if (process.stdin.readableEnded) shutdown('stdin was already closed');

  server.onclose = () => shutdown('MCP transport closed');
  server.onerror = (error) => log('error', `transport error: ${error.message}`);

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  log('info', `${SERVER_NAME} v${SERVER_VERSION} ready`, {
    port: bridge.address.port,
    tools: TOOLS.map((tool) => tool.name),
  });
}

main().catch((error: unknown) => {
  log('error', `fatal: ${describeError(error)}`);
  process.exit(1);
});
