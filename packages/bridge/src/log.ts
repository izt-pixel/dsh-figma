/**
 * stderr-only logger.
 *
 * stdout is the MCP stdio channel, so a single stray `console.log` would
 * corrupt the JSON-RPC stream. Nothing in this package writes to stdout.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentThreshold(): number {
  const requested = process.env['FIGMA_BRIDGE_LOG'];
  if (requested !== undefined && requested in LEVEL_ORDER) {
    return LEVEL_ORDER[requested as Level];
  }
  return LEVEL_ORDER.info;
}

const THRESHOLD = currentThreshold();

export function log(level: Level, message: string, detail?: unknown): void {
  if (LEVEL_ORDER[level] < THRESHOLD) return;
  const suffix = detail === undefined ? '' : ` ${safeJson(detail)}`;
  process.stderr.write(`[figma-bridge] ${level} ${message}${suffix}\n`);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : safeJson(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
