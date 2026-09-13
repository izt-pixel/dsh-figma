import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  BridgeErrorCode,
  CLIENT_STALE_MS,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_COMMAND_TIMEOUT_MS,
  HEALTH_PATH,
  LONG_POLL_MS,
  MAX_BODY_BYTES,
  POLL_PATH,
  PROTOCOL_VERSION,
  commandError,
  failedResult,
  parsePollRequest,
  type ClientSummary,
  type CommandError,
  type CommandRequest,
  type CommandResult,
  type HealthResponse,
  type PluginIdentity,
  type PollRequest,
  type PollResponse,
} from '@dsh-figma/protocol';
import { describeError, log } from './log.js';

/** How often abandoned commands are swept because their plugin went away. */
const SWEEP_INTERVAL_MS = 15_000;

/** Multiples of `clientStaleMs` after which a dead client is forgotten entirely. */
const FORGET_STALE_MULTIPLIER = 8;

/**
 * An error that already carries a model-facing, actionable `CommandError`.
 * Everything the bridge rejects on purpose uses this so callers never have to
 * invent an explanation from a stack trace.
 */
export class BridgeFailure extends Error {
  constructor(readonly detail: CommandError) {
    super(detail.message);
    this.name = 'BridgeFailure';
  }
}

/**
 * One connected Figma plugin instance.
 *
 * The plugin can only pull, so the bridge keeps at most one parked HTTP
 * response ("held") per client and hands it the next queued command. Commands
 * are delivered one at a time, which is what makes the plugin's execution
 * strictly serial and its result ordering trivially correct.
 */
class FigmaClient {
  identity: PluginIdentity;
  lastSeenAt = Date.now();

  private readonly queue: CommandRequest[] = [];
  private readonly awaiting = new Map<string, (result: CommandResult) => void>();
  /** Ids handed to the plugin whose results have not come back yet. */
  private readonly inflight = new Set<string>();
  private held: ServerResponse | null = null;
  private heldTimer: NodeJS.Timeout | null = null;
  private everPolled = false;

  constructor(
    readonly token: string,
    identity: PluginIdentity,
    private readonly longPollMs: number,
    private readonly clientStaleMs: number,
  ) {
    this.identity = identity;
  }

  get lastSeenMsAgo(): number {
    return Date.now() - this.lastSeenAt;
  }

  /**
   * Whether the client looks gone.
   *
   * The plugin's poll loop is strictly serial: it delivers a command's result on
   * its *next* poll, so a plugin executing a command cannot poll meanwhile.
   * Silence is therefore expected while a command is in flight, and treating it
   * as death would abandon work that is still running — precisely on the
   * expensive commands (whole-frame screenshots, bulk node edits) where it hurts
   * most. That case is bounded by the command's own timeout instead.
   *
   * A *queued* command is different: nothing has been handed over yet, so a
   * silent client really has gone away and failing fast is correct.
   */
  get isStale(): boolean {
    if (this.inflight.size > 0) return false;
    return this.lastSeenMsAgo > this.clientStaleMs;
  }

  /** True while a delivered command is still awaiting its result. */
  get busy(): boolean {
    return this.inflight.size > 0;
  }

  get pendingCommands(): number {
    return this.queue.length + this.awaiting.size;
  }

  summary(): ClientSummary {
    return {
      token: this.token,
      identity: this.identity,
      connected: this.everPolled && !this.isStale,
      busy: this.busy,
      lastSeenMsAgo: this.lastSeenMsAgo,
      pendingCommands: this.pendingCommands,
    };
  }

  /** Register interest in a command's result before it is queued. */
  expect(id: string, settle: (result: CommandResult) => void): void {
    this.awaiting.set(id, settle);
  }

  /** Stop waiting for a command, e.g. because its budget expired. */
  forget(id: string): void {
    this.awaiting.delete(id);
    this.inflight.delete(id);
  }

  enqueue(command: CommandRequest): void {
    this.queue.push(command);
    this.flushHeld();
  }

  handlePoll(request: PollRequest, response: ServerResponse): void {
    this.identity = request.client;
    this.lastSeenAt = Date.now();
    this.everPolled = true;

    for (const result of request.results) {
      const settle = this.awaiting.get(result.id);
      this.inflight.delete(result.id);
      if (settle === undefined) continue; // Already timed out; drop quietly.
      this.awaiting.delete(result.id);
      settle(result);
    }

    // A poll from an overlapping cycle must not leave a stale parked response.
    this.releaseHeld();
    this.held = response;
    response.on('close', () => {
      if (this.held === response) this.releaseHeld();
    });

    if (this.queue.length > 0) {
      this.flushHeld();
      return;
    }

    this.heldTimer = setTimeout(() => {
      this.releaseHeld();
      this.respond(response, {
        v: PROTOCOL_VERSION,
        token: this.token,
        commands: [],
        serverTime: Date.now(),
      });
    }, this.longPollMs);
  }

  /** Settle everything still waiting, used when the plugin disappears. */
  abandonAll(error: CommandError): void {
    const waiting = [...this.awaiting.values()];
    this.awaiting.clear();
    this.inflight.clear();
    this.queue.length = 0;
    for (const settle of waiting) settle(failedResult('', error));
  }

  dispose(): void {
    this.releaseHeld();
  }

  private flushHeld(): void {
    const response = this.held;
    if (response === null) return;
    const command = this.queue.shift();
    if (command === undefined) return;
    this.releaseHeld();
    // Mark the command delivered: from here on, silence means "busy", not "gone".
    this.inflight.add(command.id);
    this.respond(response, {
      v: PROTOCOL_VERSION,
      token: this.token,
      commands: [command],
      serverTime: Date.now(),
    });
  }

  private releaseHeld(): void {
    if (this.heldTimer !== null) {
      clearTimeout(this.heldTimer);
      this.heldTimer = null;
    }
    this.held = null;
  }

  private respond(response: ServerResponse, body: PollResponse): void {
    writeJson(response, 200, body);
  }
}

export interface BridgeOptions {
  port?: number;
  host?: string;
  commandTimeoutMs?: number;
  /** How long an idle plugin poll is parked. Shortened in tests. */
  longPollMs?: number;
  /**
   * A client that has not polled for this long is treated as gone. The plugin
   * polls continuously, so this only needs to cover the long-poll window plus
   * slack; lowering it makes the bridge notice a restarted Figma sooner.
   */
  clientStaleMs?: number;
  /** How often abandoned commands are swept. */
  sweepIntervalMs?: number;
}

/**
 * Loopback addresses to bind in addition to the primary one.
 *
 * The plugin has to address the bridge as `http://localhost:<port>` (Figma's
 * manifest validator rejects an IPv4 literal), and `localhost` may resolve to
 * either family, so both are bound.
 */
function companionHosts(host: string): string[] {
  if (host === '127.0.0.1') return ['::1'];
  if (host === '::1') return ['127.0.0.1'];
  return [];
}

/**
 * Render a bound address as a URL.
 *
 * An IPv6 literal must be bracketed, otherwise `http://::1:8790` is ambiguous —
 * which is exactly how it showed up in `/figma/health` and in the logs.
 */
function formatOrigin(host: string, port: number): string {
  const authority = host.includes(':') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

/** Promise wrapper around `server.listen`, resolving once the socket is bound. */
function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Owns the loopback HTTP server the Figma plugin polls, plus the client registry. */
export class FigmaBridge {
  private readonly clients = new Map<string, FigmaClient>();
  private readonly servers = new Map<string, Server>();
  private readonly port: number;
  private readonly host: string;
  private readonly commandTimeoutMs: number;
  private readonly longPollMs: number;
  private readonly clientStaleMs: number;
  private readonly sweepIntervalMs: number;
  private readonly forgetAfterMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: BridgeOptions = {}) {
    this.port = options.port ?? DEFAULT_BRIDGE_PORT;
    this.host = options.host ?? DEFAULT_BRIDGE_HOST;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.longPollMs = options.longPollMs ?? LONG_POLL_MS;
    this.clientStaleMs = options.clientStaleMs ?? CLIENT_STALE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.forgetAfterMs = this.clientStaleMs * FORGET_STALE_MULTIPLIER;
  }

  get address(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  get isListening(): boolean {
    return this.servers.size > 0;
  }

  /** Addresses actually bound, in bind order. */
  get addresses(): string[] {
    return [...this.servers.keys()].map((host) => formatOrigin(host, this.port));
  }

  async listen(): Promise<void> {
    if (this.servers.size > 0) return;

    const primary = createServer((request, response) => {
      void this.route(request, response);
    });

    try {
      await listenOn(primary, this.port, this.host);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        throw new BridgeFailure(
          commandError(
            BridgeErrorCode.BridgeError,
            `Port ${this.port} on ${this.host} is already in use.`,
            `Another DSH session is most likely already running a bridge on this port. Stop it, or set FIGMA_BRIDGE_PORT to a free port here and enter the same port in the plugin panel.`,
            { port: this.port, host: this.host },
          ),
        );
      }
      throw new BridgeFailure(
        commandError(
          BridgeErrorCode.BridgeError,
          `Could not bind ${this.host}:${this.port} — ${(error as Error).message}`,
          undefined,
        ),
      );
    }
    this.servers.set(this.host, primary);

    // The plugin must address the bridge as `http://localhost:<port>`, because
    // Figma's manifest validator rejects an IPv4 literal in allowedDomains. But
    // `localhost` resolves to ::1 on some machines and 127.0.0.1 on others, so
    // binding only the primary family would leave the plugin unable to connect.
    // Binding both families keeps the bridge loopback-only while making the
    // plugin's one allowed hostname work either way.
    for (const host of companionHosts(this.host)) {
      const companion = createServer((request, response) => {
        void this.route(request, response);
      });
      try {
        await listenOn(companion, this.port, host);
        this.servers.set(host, companion);
        log('debug', `also listening on ${formatOrigin(host, this.port)}`);
      } catch (error) {
        log('debug', `could not also bind ${host}: ${describeError(error)}`);
      }
    }

    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
    log(
      'info',
      `listening on ${this.addresses.map((origin) => `${origin}${POLL_PATH}`).join(', ')}`,
    );
  }

  async close(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();

    const servers = [...this.servers.values()];
    this.servers.clear();
    if (servers.length === 0) return;

    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  }

  health(): HealthResponse {
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      port: this.port,
      addresses: this.addresses,
      clients: [...this.clients.values()].map((client) => client.summary()),
    };
  }

  /**
   * Run one command on the connected plugin and wait for its result.
   *
   * Never rejects: a failure comes back as a failed `CommandResult` carrying a
   * `CommandError`, because "no plugin connected" is an ordinary, expected
   * outcome the model must be able to read and act on.
   */
  async command(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number = this.commandTimeoutMs,
  ): Promise<CommandResult> {
    let client: FigmaClient;
    try {
      client = this.resolveClient();
    } catch (error) {
      if (error instanceof BridgeFailure) {
        return failedResult('', error.detail);
      }
      throw error;
    }

    // The plugin advertises the commands its build implements on every poll, so
    // a tool the model can see but the connected plugin cannot run is caught
    // here with a precise instruction, rather than failing opaquely inside Figma
    // because the user has not re-run the plugin since the last bridge build.
    const advertised = client.identity.commands;
    if (advertised.length > 0 && !advertised.includes(name)) {
      return failedResult(
        '',
        commandError(
          BridgeErrorCode.PluginMissingCommand,
          `The connected plugin build does not implement "${name}".`,
          `It advertises: ${advertised.join(', ')}. Re-run the plugin in Figma (Plugins → Development → DSH Figma Bridge) so it loads the current build.`,
          { command: name, advertised },
        ),
      );
    }

    const request: CommandRequest = { id: randomUUID(), name, args };
    const startedAt = Date.now();

    return await new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        client.forget(request.id);
        log('warn', `command timed out`, { name, id: request.id, timeoutMs });
        resolve(
          failedResult(
            request.id,
            commandError(
              BridgeErrorCode.CommandTimeout,
              `The plugin did not answer "${name}" within ${timeoutMs} ms.`,
              'Figma may be busy or showing a modal. The command may still be running — check the Figma window, then retry with a smaller request.',
              { name, timeoutMs },
            ),
            Date.now() - startedAt,
          ),
        );
      }, timeoutMs);

      client.expect(request.id, (result) => {
        clearTimeout(timer);
        resolve({ ...result, id: request.id });
      });

      log('debug', `dispatch`, { name, id: request.id, port: this.port });
      client.enqueue(request);
    });
  }

  private resolveClient(): FigmaClient {
    const live = [...this.clients.values()].filter((client) => !client.isStale);

    if (live.length === 1) return live[0] as FigmaClient;

    if (live.length === 0) {
      const known = this.clients.size;
      throw new BridgeFailure(
        commandError(
          BridgeErrorCode.NoPlugin,
          known === 0
            ? 'No Figma plugin has ever connected to this bridge.'
            : 'A Figma plugin connected earlier but has stopped polling.',
          'Open the Figma file, run Plugins → Development → DSH Figma Bridge, and confirm its panel says "connected". If the plugin is already open, check that its port matches this bridge.',
          { port: this.port, knownClients: known },
        ),
      );
    }

    const names = live
      .map((client) => client.identity.fileName ?? client.identity.pageName)
      .join(', ');
    throw new BridgeFailure(
      commandError(
        BridgeErrorCode.AmbiguousPlugin,
        `${live.length} Figma plugin instances are connected at once (${names}).`,
        'Close the plugin in every file except the one you want to work on. Multi-file routing is not implemented yet.',
        { clients: live.map((client) => client.summary()) },
      ),
    );
  }

  /** Drop commands whose plugin went away, so callers fail fast and clearly. */
  private sweep(): void {
    for (const [token, client] of this.clients) {
      if (client.lastSeenMsAgo > this.forgetAfterMs) {
        client.dispose();
        this.clients.delete(token);
        log('info', `forgot stale client`, { token });
        continue;
      }
      if (client.isStale) {
        client.abandonAll(
          commandError(
            BridgeErrorCode.PluginDisconnected,
            'The Figma plugin stopped polling while this command was in flight.',
            'Re-run the plugin in Figma, then retry.',
          ),
        );
      }
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The plugin runs with a null origin, so every response needs an explicit
    // permissive CORS header for the browser to hand the body to the plugin.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    const url = request.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    if (request.method === 'GET' && path === HEALTH_PATH) {
      writeJson(response, 200, this.health());
      return;
    }

    if (request.method === 'POST' && path === POLL_PATH) {
      await this.handlePoll(request, response);
      return;
    }

    writeJson(response, 404, {
      error: 'NOT_FOUND',
      message: `No route for ${request.method ?? 'GET'} ${path}.`,
      hint: `Use POST ${POLL_PATH} or GET ${HEALTH_PATH}.`,
    });
  }

  private async handlePoll(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let raw: string | null;
    try {
      raw = await readBody(request);
    } catch (error) {
      writeJson(response, 413, {
        error: BridgeErrorCode.BadRequest,
        message: `Request body rejected: ${(error as Error).message}`,
      });
      return;
    }
    if (raw === null) {
      writeJson(response, 400, {
        error: BridgeErrorCode.BadRequest,
        message: 'Request body was empty or not valid UTF-8.',
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      writeJson(response, 400, {
        error: BridgeErrorCode.BadRequest,
        message: `Request body is not valid JSON: ${(error as Error).message}`,
      });
      return;
    }

    const poll = parsePollRequest(parsed);
    if (poll === null) {
      writeJson(response, 400, {
        error: BridgeErrorCode.BadRequest,
        message: 'Request body is not a valid poll envelope.',
        hint: `Expected { v, token, client, results }.`,
      });
      return;
    }

    if (poll.v !== PROTOCOL_VERSION) {
      const message = `Protocol mismatch: the plugin speaks v${poll.v}, this bridge speaks v${PROTOCOL_VERSION}.`;
      log('error', message, { pluginVersion: poll.client.pluginVersion });
      writeJson(response, 409, {
        error: BridgeErrorCode.ProtocolMismatch,
        message,
        hint: 'Rebuild the plugin and the bridge from the same revision, then re-run the plugin in Figma.',
      });
      return;
    }

    const token = poll.token ?? randomUUID();
    let client = this.clients.get(token);
    if (client === undefined) {
      client = new FigmaClient(token, poll.client, this.longPollMs, this.clientStaleMs);
      this.clients.set(token, client);
      log('info', `plugin connected`, {
        token,
        fileName: poll.client.fileName,
        page: poll.client.pageName,
        pluginVersion: poll.client.pluginVersion,
      });
    }
    client.handlePoll(poll, response);
  }
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new Error(`body exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
