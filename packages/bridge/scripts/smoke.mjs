/**
 * End-to-end smoke test for the bridge, with a fake plugin standing in for
 * Figma.
 *
 * Everything runs in one process. The dev sandbox denies piped child stdio, so
 * spawning the real MCP binary is deliberately not done here — what this covers
 * is the part that actually has logic in it: the long-poll hold, token issuing,
 * one-command-at-a-time delivery, result piggybacking, timeouts, and rejection
 * paths.
 *
 *   node packages/bridge/scripts/smoke.mjs
 */

import { FigmaBridge } from '../dist/bridge.js';
import { contentForResult } from '../dist/render.js';
import {
  MAX_IMAGES_PER_RESULT,
  MAX_IMAGE_BASE64_CHARS,
  PROTOCOL_VERSION,
} from '@dsh-figma/protocol';

const PORT = 8791;
const LONG_POLL_MS = 250;
const COMMAND_TIMEOUT_MS = 1_500;

let failures = 0;

function check(name, passed, detail) {
  if (passed) {
    console.log(`  ok    ${name}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  return false;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate, { timeoutMs = 3_000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(stepMs);
  }
  return false;
}

/** Stands in for the Figma plugin: long-polls, executes, piggybacks results. */
class FakePlugin {
  /**
   * @param port
   * @param handlers - commands this fake can actually execute.
   * @param advertised - commands it claims to support. Defaults to the handled
   * ones; pass a superset to model a plugin that accepts a command but never
   * answers it, which is what the timeout path needs.
   */
  constructor(port, handlers, advertised = Object.keys(handlers)) {
    this.port = port;
    this.handlers = handlers;
    this.advertised = advertised;
    this.token = null;
    this.pending = [];
    this.received = [];
    this.pollDurations = [];
    this.stopped = false;
    this.lastHttpError = null;
    this.identity = {
      pluginVersion: 'smoke',
      apiVersion: '1.0.0',
      editorType: 'figma',
      fileName: 'Smoke Test File',
      pageName: 'Page 1',
      pageId: '0:1',
      selectionCount: 2,
      commands: this.advertised,
    };
  }

  async run() {
    while (!this.stopped) {
      const startedAt = Date.now();
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${this.port}/figma/poll`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({
            v: PROTOCOL_VERSION,
            token: this.token,
            client: this.identity,
            results: this.pending,
          }),
        });
      } catch {
        if (this.stopped) return;
        await wait(20);
        continue;
      }

      if (!response.ok) {
        this.lastHttpError = { status: response.status, body: await response.text() };
        return;
      }

      const body = await response.json();
      this.pollDurations.push(Date.now() - startedAt);
      this.token = body.token;
      this.pending = [];

      for (const command of body.commands) {
        this.received.push(command);
        const handler = this.handlers[command.name];
        if (handler === undefined) continue; // Models "plugin ignores it".
        this.pending.push(await handler(command));
      }
    }
  }
}

const bridge = new FigmaBridge({
  port: PORT,
  host: '127.0.0.1',
  longPollMs: LONG_POLL_MS,
  commandTimeoutMs: COMMAND_TIMEOUT_MS,
  // Compress the disconnect detection so section 9 finishes in under a second
  // instead of waiting out the 70 s production staleness window.
  clientStaleMs: 400,
  sweepIntervalMs: 100,
});

await bridge.listen();
const base = `http://127.0.0.1:${PORT}`;

console.log('\n1. no plugin connected');

const orphan = await bridge.command('status', {});
check('fails instead of hanging', orphan.ok === false);
check(
  'reports NO_PLUGIN',
  orphan.error?.code === 'NO_PLUGIN',
  JSON.stringify(orphan.error),
);
check(
  'hint tells the operator what to do',
  typeof orphan.error?.hint === 'string' && orphan.error.hint.includes('Plugins'),
  orphan.error?.hint,
);

console.log('\n2. plugin connects');

const executions = [];
const plugin = new FakePlugin(
  PORT,
  {
    status: (command) => {
      executions.push({ name: command.name, args: command.args });
      return { id: command.id, ok: true, durationMs: 7, result: { fileName: 'Smoke Test File', commands: ['status', 'ping'] } };
    },
    ping: (command) => {
      executions.push({ name: command.name, args: command.args });
      return { id: command.id, ok: true, durationMs: 2, result: { echo: command.args.echo ?? null } };
    },
  },
  // 'mystery' and 'slowpoke' are advertised but deliberately unhandled: they
  // model a plugin that accepts a command and then never answers, which is the
  // timeout path and the "silent while busy" path respectively.
  ['status', 'ping', 'mystery', 'slowpoke'],
);
const pluginLoop = plugin.run();

check('first poll parks instead of spinning', await until(() => plugin.pollDurations.length >= 1));
check(
  'idle poll is held for the long-poll window',
  plugin.pollDurations[0] >= LONG_POLL_MS - 80,
  `returned after ${plugin.pollDurations[0]} ms, window is ${LONG_POLL_MS} ms`,
);
check('bridge issues a token', typeof plugin.token === 'string' && plugin.token.length > 0);

console.log('\n3. command round trip');

const first = await bridge.command('status', {});
check('status succeeds', first.ok === true, JSON.stringify(first.error));
check('result is the plugin payload, not a wrapper', first.result?.fileName === 'Smoke Test File');
check('one command was delivered', plugin.received.length === 1);
check('it was addressed by id', plugin.received[0]?.id === first.id);
check('plugin saw an empty args object', JSON.stringify(executions[0]?.args) === '{}');

console.log('\n4. arguments and ordering survive');

const second = await bridge.command('ping', { echo: 'hello-figma' });
check('ping succeeds', second.ok === true, JSON.stringify(second.error));
check('argument echoed back', second.result?.echo === 'hello-figma');
check(
  'commands arrive in call order',
  plugin.received.map((entry) => entry.name).join(',') === 'status,ping',
  plugin.received.map((entry) => entry.name).join(','),
);
check('ids are unique', first.id !== second.id);

console.log('\n5. plugin that never answers');

const startedTimeout = Date.now();
const timedOut = await bridge.command('mystery', {}, 250);
check('times out rather than hanging', timedOut.ok === false);
check('reports COMMAND_TIMEOUT', timedOut.error?.code === 'COMMAND_TIMEOUT', JSON.stringify(timedOut.error));
check('honours the supplied budget', Date.now() - startedTimeout < 1_500);

const afterTimeout = await bridge.command('status', {});
check('link still usable after a timeout', afterTimeout.ok === true, JSON.stringify(afterTimeout.error));

console.log('\n5b. a command this plugin build does not implement');

const notImplemented = await bridge.command('apply', {});
check(
  'is caught before it reaches Figma',
  notImplemented.error?.code === 'PLUGIN_MISSING_COMMAND',
  JSON.stringify(notImplemented.error),
);
check(
  'the hint names the commands the plugin does advertise',
  typeof notImplemented.error?.hint === 'string' &&
    notImplemented.error.hint.includes('status') &&
    notImplemented.error.hint.toLowerCase().includes('re-run'),
  notImplemented.error?.hint,
);
check(
  'it was never delivered to the plugin',
  !plugin.received.some((entry) => entry.name === 'apply'),
  JSON.stringify(plugin.received.map((entry) => entry.name)),
);

console.log('\n6. protocol mismatch is rejected loudly');

const mismatched = await fetch(`${base}/figma/poll`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: JSON.stringify({ v: 999, token: null, client: plugin.identity, results: [] }),
});
const mismatchBody = await mismatched.json();
check('answers 409', mismatched.status === 409, String(mismatched.status));
check('names the mismatch', mismatchBody.error === 'PROTOCOL_MISMATCH', JSON.stringify(mismatchBody));
check('says how to fix it', typeof mismatchBody.hint === 'string' && mismatchBody.hint.length > 0);

console.log('\n7. malformed input is rejected without killing the bridge');

const garbage = await fetch(`${base}/figma/poll`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: JSON.stringify({ nonsense: true }),
});
check('bad envelope answers 400', garbage.status === 400, String(garbage.status));
const stillAlive = await bridge.command('ping', {});
check('bridge survives malformed input', stillAlive.ok === true, JSON.stringify(stillAlive.error));

console.log('\n8. diagnostics endpoint');

const health = await (await fetch(`${base}/figma/health`)).json();
check('reports the protocol version', health.protocolVersion === PROTOCOL_VERSION);
check('lists the connected client', health.clients?.length === 1, JSON.stringify(health.clients));
check('shows the file name', health.clients?.[0]?.identity?.fileName === 'Smoke Test File');
check('selection count is visible to the model', health.clients?.[0]?.identity?.selectionCount === 2);
check('reports the bound addresses', Array.isArray(health.addresses) && health.addresses.length >= 1, JSON.stringify(health.addresses));

// Regression guard for the manifest validator constraint: Figma rejects an IPv4
// literal in networkAccess.allowedDomains, so the plugin's only permitted origin
// is http://localhost:<port>. If the bridge were bound to one address family
// only, `localhost` could resolve to the other one and the plugin would report
// "offline" with no way to recover.
const viaLocalhost = await fetch(`http://localhost:${PORT}/figma/health`)
  .then((response) => response.json())
  .catch((error) => ({ error: String(error) }));
check(
  'reachable as http://localhost:<port>, the plugin\'s only allowed origin',
  viaLocalhost.protocolVersion === PROTOCOL_VERSION,
  JSON.stringify(viaLocalhost),
);
check(
  'binds both loopback families',
  bridge.addresses.some((entry) => entry.includes('127.0.0.1')) &&
    bridge.addresses.some((entry) => entry.includes('::1')),
  JSON.stringify(bridge.addresses),
);
check(
  'brackets IPv6 origins so they are valid URLs',
  bridge.addresses.every((entry) => !entry.includes('::') || entry.includes('[::1]')),
  JSON.stringify(bridge.addresses),
);

console.log('\n9. silence means "busy" while a command is in flight, and "gone" when idle');

// The plugin's poll loop is serial: it returns a result on its NEXT poll, so a
// plugin executing a command cannot poll meanwhile. Declaring it dead for that
// silence would abandon work that is still running — on exactly the expensive
// commands where it hurts most. This is the regression guard for that.
const LONG_BUDGET_MS = 1_500;
let busySettledAt = null;
const busyPromise = bridge.command('slowpoke', {}, LONG_BUDGET_MS);
void busyPromise.then(() => {
  busySettledAt = Date.now();
});

check(
  'the plugin took delivery, so the command is genuinely in flight',
  await until(() => plugin.received.some((entry) => entry.name === 'slowpoke'), { timeoutMs: 1_000 }),
);

// Kill the plugin while the command is in flight and its result is outstanding.
plugin.stopped = true;
await pluginLoop;

// Wait well past the staleness window (400 ms) and several sweeps (100 ms).
await wait(900);

const whileBusy = bridge.health().clients.find((c) => c.identity.fileName === 'Smoke Test File');
check(
  'a busy client is not declared disconnected just for going quiet',
  whileBusy?.connected === true,
  JSON.stringify(whileBusy),
);
check(
  'and it is reported busy, so the state stays legible',
  whileBusy?.busy === true,
  JSON.stringify(whileBusy),
);
check(
  'the in-flight command is not abandoned early',
  busySettledAt === null,
  `it settled ${busySettledAt === null ? 'never' : `${Date.now() - busySettledAt} ms ago`}`,
);

const busyResult = await busyPromise;
check(
  'it ends as a timeout rather than a phantom disconnect',
  busyResult.ok === false && busyResult.error?.code === 'COMMAND_TIMEOUT',
  JSON.stringify(busyResult.error),
);
check(
  'and it still carries a command id',
  typeof busyResult.id === 'string' && busyResult.id.length > 0,
  JSON.stringify(busyResult),
);

// With nothing in flight, the same silence now does mean gone.
await wait(900);
const whileIdle = bridge.health().clients.find((c) => c.identity.fileName === 'Smoke Test File');
check('an idle client that stops polling is detected', whileIdle?.connected === false, JSON.stringify(whileIdle));
check('and it is no longer reported busy', whileIdle?.busy === false, JSON.stringify(whileIdle));

const fastFailStartedAt = Date.now();
const afterDisconnect = await bridge.command('status', {});
check(
  'a new command fails fast instead of waiting out the budget',
  afterDisconnect.ok === false && Date.now() - fastFailStartedAt < 500,
  `${Date.now() - fastFailStartedAt} ms — ${JSON.stringify(afterDisconnect.error)}`,
);
check(
  'and it reports the plugin is gone rather than a timeout',
  afterDisconnect.error?.code === 'NO_PLUGIN',
  JSON.stringify(afterDisconnect.error),
);

await bridge.close();

/* -------------------------------------------------------------------------
 * Tool-result rendering, tested directly.
 *
 * This is the half of the system that fails silently: a screenshot that does
 * not reach the model as an image looks exactly like a tool that returned
 * nothing, and the model would then judge a design it never saw.
 * ---------------------------------------------------------------------- */

console.log('\n10. tool-result rendering');

const okResult = contentForResult('ping', {
  id: 'c1',
  ok: true,
  durationMs: 3,
  result: { echo: 'hi' },
});
check('a plain result renders as one text block', okResult.length === 1 && okResult[0].type === 'text');
check(
  'the text carries the tool name and payload',
  okResult[0].text.includes('"ping"') && okResult[0].text.includes('"hi"'),
  okResult[0].text,
);

const failedRender = contentForResult('status', {
  id: 'c2',
  ok: false,
  durationMs: 0,
  error: { code: 'NO_PLUGIN', message: 'nothing connected', hint: 'run the plugin in Figma' },
});
check(
  'a failure renders its code, message, and hint',
  failedRender.length === 1 &&
    failedRender[0].text.includes('NO_PLUGIN') &&
    failedRender[0].text.includes('nothing connected') &&
    failedRender[0].text.includes('run the plugin in Figma'),
  failedRender[0].text,
);

// A real 1x1 PNG, so the bytes are genuine base64 rather than filler.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const bundleRender = contentForResult('screenshot', {
  id: 'c3',
  ok: true,
  durationMs: 42,
  result: {
    images: [
      {
        mimeType: 'image/png',
        base64: PNG_BASE64,
        byteLength: 70,
        width: 750,
        height: 1624,
        nodeId: '1:2',
        nodeName: 'Home / Mobile',
        scale: 2,
      },
    ],
    skipped: [{ nodeId: '1:9', nodeName: 'Hidden Panel', reason: 'the node was removed' }],
  },
});

const renderedImages = bundleRender.filter((block) => block.type === 'image');
const renderedTexts = bundleRender.filter((block) => block.type === 'text');
check('an image bundle yields real MCP image content', renderedImages.length === 1);
check(
  'base64 survives byte-for-byte',
  renderedImages[0].data === PNG_BASE64,
  renderedImages[0].data.slice(0, 24),
);
check('the MIME type is carried through', renderedImages[0].mimeType === 'image/png');
check(
  'the caption precedes its image, so pictures stay tied to node ids',
  bundleRender[0].type === 'text' && bundleRender[1].type === 'image',
  bundleRender.map((block) => block.type).join(','),
);
check(
  'the caption names the node, pixel size, and effective scale',
  renderedTexts[0].text.includes('1:2') &&
    renderedTexts[0].text.includes('Home / Mobile') &&
    renderedTexts[0].text.includes('750x1624') &&
    renderedTexts[0].text.includes('2x'),
  renderedTexts[0].text,
);
check(
  'a node that could not be captured is reported, not silently omitted',
  renderedTexts.some((block) => block.text.includes('Hidden Panel') && block.text.includes('removed')),
  JSON.stringify(renderedTexts.map((block) => block.text)),
);

const overCap = contentForResult('screenshot', {
  id: 'c4',
  ok: true,
  durationMs: 1,
  result: {
    images: Array.from({ length: MAX_IMAGES_PER_RESULT + 3 }, (_, index) => ({
      mimeType: 'image/png',
      base64: PNG_BASE64,
      byteLength: 70,
      width: 10,
      height: 10,
      nodeId: `1:${index}`,
      nodeName: `node ${index}`,
      scale: 1,
    })),
    skipped: [],
  },
});
check(
  'images are capped at the shared budget',
  overCap.filter((block) => block.type === 'image').length === MAX_IMAGES_PER_RESULT,
  String(overCap.filter((block) => block.type === 'image').length),
);
check(
  'the cap is stated with a way forward',
  overCap.at(-1).text.includes('not attached'),
  overCap.at(-1).text,
);

const oversized = contentForResult('screenshot', {
  id: 'c5',
  ok: true,
  durationMs: 1,
  result: {
    images: [
      {
        mimeType: 'image/png',
        base64: 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1),
        byteLength: MAX_IMAGE_BASE64_CHARS,
        width: 100,
        height: 100,
        nodeId: '1:1',
        nodeName: 'enormous',
        scale: 4,
      },
    ],
    skipped: [],
  },
});
check(
  'an oversized image is refused rather than forwarded',
  oversized.filter((block) => block.type === 'image').length === 0,
);
check(
  'and the refusal explains itself instead of looking like an empty canvas',
  oversized[0].text.includes('No image could be produced') &&
    oversized[0].text.includes('Lower the scale'),
  oversized[0].text,
);

const malformed = contentForResult('screenshot', {
  id: 'c6',
  ok: true,
  durationMs: 1,
  result: { images: [{ mimeType: 'image/svg+xml', base64: '<svg/>', width: 1, height: 1 }], skipped: [] },
});
check(
  'a non-image MIME type is not passed off as an image',
  malformed.filter((block) => block.type === 'image').length === 0,
  JSON.stringify(malformed.map((block) => block.type)),
);

const emptyBundle = contentForResult('screenshot', {
  id: 'c7',
  ok: true,
  durationMs: 1,
  result: { images: [], skipped: [{ nodeId: '1:1', reason: 'zero-sized bounds (0x0)' }] },
});
check(
  'an empty bundle still tells the model why nothing came back',
  emptyBundle.length === 1 &&
    emptyBundle[0].text.includes('No image could be produced') &&
    emptyBundle[0].text.includes('zero-sized'),
  emptyBundle[0].text,
);

console.log(
  failures === 0
    ? '\nAll smoke checks passed.\n'
    : `\n${failures} smoke check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
