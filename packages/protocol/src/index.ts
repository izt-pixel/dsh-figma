/**
 * Wire protocol between the DSH Figma bridge (a local Node process) and the
 * Figma plugin.
 *
 * ## Why long polling instead of a socket
 *
 * The Figma plugin sandbox exposes exactly these non-Figma globals: `fetch`,
 * `console`, `setTimeout` / `clearTimeout` / `setInterval` / `clearInterval`,
 * `__html__`, and `__uiFiles__` (see `@figma/plugin-typings/index.d.ts`).
 * There is no `WebSocket`, no `window`, and no `localStorage`. A plugin also
 * cannot listen on a port, so the bridge can never dial the plugin.
 *
 * The plugin therefore *pulls* work with a long-polling POST and piggybacks the
 * results of the previous batch onto the next request. One round trip both
 * delivers a command and reports the previous outcome, and command ordering is
 * preserved for free because the plugin's loop is strictly serial.
 */

/**
 * Bumped whenever the request/response shapes change incompatibly.
 *
 * The plugin cannot import this value at runtime (it must stay a single
 * dependency-free file for Figma to load), so it carries its own literal copy
 * and the bridge rejects mismatched polls with `PROTOCOL_MISMATCH` instead of
 * failing silently.
 */
export const PROTOCOL_VERSION = 1;

/** Loopback port the bridge listens on. The plugin may override it locally. */
export const DEFAULT_BRIDGE_PORT = 8790;

/** Default bind address: loopback only, so the bridge is never exposed. */
export const DEFAULT_BRIDGE_HOST = '127.0.0.1';

/** How long an idle poll is held open before the bridge answers with no work. */
export const LONG_POLL_MS = 25_000;

/** A client that has not polled within this window is treated as gone. */
export const CLIENT_STALE_MS = 70_000;

/** Default budget for one command, measured on the bridge side. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Upper bound on a single request body. Generous because screenshots travel
 * back as base64 in the results array of a poll.
 */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/* -------------------------------------------------------------------------
 * Budgets shared by the plugin and the bridge
 *
 * Both sides enforce the same numbers so neither can surprise the other: the
 * plugin clamps what it exports, and the bridge clamps what it forwards into
 * the model's context. Images are expensive — every pixel becomes visual
 * tokens — so these are deliberately tight.
 * ---------------------------------------------------------------------- */

/** Images attached to one tool result. Beyond this the model is told what was dropped. */
export const MAX_IMAGES_PER_RESULT = 4;

/**
 * Pixel budget for one exported image. A 1440x900 frame at 1x is ~1.3M px, so
 * this fits a full desktop frame at 1x or a phone frame at 2x.
 */
export const MAX_IMAGE_PIXELS = 1_600_000;

/** Hard ceiling on one image's base64 payload, guarding the poll body limit. */
export const MAX_IMAGE_BASE64_CHARS = 12_000_000;

/** Nodes `describe` may return before it truncates and says so. */
export const MAX_DESCRIBE_NODES = 400;

/** Deepest `describe` recursion. Cheap to raise, but depth is where tokens explode. */
export const MAX_DESCRIBE_DEPTH = 8;

/** Characters of a text node's content that `describe` returns. */
export const MAX_TEXT_PREVIEW_CHARS = 200;

/** HTTP path the plugin posts to. */
export const POLL_PATH = '/figma/poll';

/** HTTP path a human (or the plugin panel) can GET for diagnostics. */
export const HEALTH_PATH = '/figma/health';

/**
 * What the plugin reports about itself on every poll. Used both for diagnostics
 * and to give the model enough context to act without a separate round trip.
 */
export interface PluginIdentity {
  /** Version of the plugin bundle, for drift detection against the bridge. */
  pluginVersion: string;
  /**
   * Short hash of the compiled plugin bundle, stamped at build time.
   *
   * `pluginVersion` is a human-chosen string that stays put across builds, and
   * the command list only changes when the tool surface does — so neither can
   * answer "is Figma running the build I just wrote?". This can, and the answer
   * is visible in the plugin panel, in `/figma/health`, and to the model.
   */
  buildId: string;
  /** Figma's `apiVersion`, i.e. the `api` field of the manifest. */
  apiVersion: string;
  /** `figma.editorType`, e.g. `figma`. */
  editorType: string;
  /** File name via `figma.root.name`. Null when unavailable. */
  fileName: string | null;
  /** Current page name. */
  pageName: string;
  /** Current page id. */
  pageId: string;
  /** Number of nodes currently selected, for cheap user-intent signalling. */
  selectionCount: number;
  /** Command names this plugin build can execute. */
  commands: string[];
}

/** A single unit of work for the plugin. */
export interface CommandRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * A structured, actionable failure. `hint` exists so the model is told what to
 * do next rather than being handed a bare stack trace.
 */
export interface CommandError {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

/** Outcome of one command, addressed by id so results can be batched. */
export interface CommandResult {
  id: string;
  ok: boolean;
  /** Present when `ok` is true. */
  result?: unknown;
  /** Present when `ok` is false. */
  error?: CommandError;
  /** Wall-clock time the plugin spent executing, in milliseconds. */
  durationMs: number;
}

/** Body the plugin POSTs on every poll. */
export interface PollRequest {
  v: number;
  /** Null on the very first poll; the bridge then issues one. */
  token: string | null;
  client: PluginIdentity;
  /** Results of commands delivered by the previous poll response. */
  results: CommandResult[];
}

/** Body the bridge answers with. */
export interface PollResponse {
  v: number;
  /** Stable per-plugin-instance id; the plugin persists it in clientStorage. */
  token: string;
  /** At most one command per response, keeping the plugin strictly serial. */
  commands: CommandRequest[];
  /** Bridge clock, so the plugin can show clock skew in its panel. */
  serverTime: number;
}

/** Connection summary for one plugin instance. */
export interface ClientSummary {
  token: string;
  identity: PluginIdentity;
  /**
   * Whether the client is polling. A busy client counts as connected even while
   * quiet, because the plugin cannot poll while executing a command — read
   * `busy` to tell the two apart.
   */
  connected: boolean;
  /** True while a delivered command is still awaiting its result. */
  busy: boolean;
  lastSeenMsAgo: number;
  pendingCommands: number;
}

/** Body of the diagnostics endpoint. */
export interface HealthResponse {
  ok: boolean;
  protocolVersion: number;
  port: number;
  /** Loopback origins the bridge is bound to, e.g. `http://127.0.0.1:8790`. */
  addresses: string[];
  clients: ClientSummary[];
}

/* -------------------------------------------------------------------------
 * Image results
 *
 * A tool result of this shape is rendered by the bridge as real MCP image
 * content, so the model sees the design instead of a description of it. This is
 * what closes the design loop: the model edits the canvas, screenshots the
 * result, and critiques its own work.
 * ---------------------------------------------------------------------- */

/** One exported image, carried as base64 across the same poll channel. */
export interface ImagePayload {
  /** Always `image/png` or `image/jpeg`. */
  mimeType: string;
  /** Base64 of the raw bytes. Empty string never reaches the model. */
  base64: string;
  /** Decoded size, so the bridge can describe and guard the payload. */
  byteLength: number;
  /** Exported pixel dimensions, after scale clamping. */
  width: number;
  height: number;
  /** The node that was exported, so the model can address it again. */
  nodeId: string;
  nodeName: string;
  /** The scale actually used, which may be below the requested one. */
  scale: number;
}

/** A node the plugin could not export, with a reason the model can act on. */
export interface SkippedCapture {
  nodeId: string;
  nodeName?: string;
  reason: string;
}

/** Result shape the bridge recognises and turns into MCP image content. */
export interface ImageBundle {
  images: ImagePayload[];
  skipped: SkippedCapture[];
  /** Anything else worth telling the model about the capture. */
  notes?: string[];
}

/**
 * Narrow an unknown tool result to an image bundle.
 *
 * Deliberately shallow: a malformed bundle is far more likely to be a plugin
 * bug than an attack, and failing here would turn a renderable answer into an
 * opaque error. Individual images are validated separately so one bad payload
 * cannot discard the rest.
 */
export function isImageBundle(value: unknown): value is ImageBundle {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate['images']) && Array.isArray(candidate['skipped']);
}

/** Whether one entry of an image bundle is safe to forward to the model. */
export function isRenderableImage(value: unknown): value is ImagePayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['base64'] === 'string' &&
    candidate['base64'] !== '' &&
    (candidate['mimeType'] === 'image/png' || candidate['mimeType'] === 'image/jpeg')
  );
}

/** Error codes the bridge can produce on its own, i.e. without the plugin. */
export const BridgeErrorCode = {
  /** No plugin instance has ever connected. */
  NoPlugin: 'NO_PLUGIN',
  /** A plugin connected but has stopped polling. */
  PluginDisconnected: 'PLUGIN_DISCONNECTED',
  /** More than one plugin instance is live and the caller did not disambiguate. */
  AmbiguousPlugin: 'AMBIGUOUS_PLUGIN',
  /** The plugin is connected but its build does not implement this command. */
  PluginMissingCommand: 'PLUGIN_MISSING_COMMAND',
  /** The plugin did not return a result inside the budget. */
  CommandTimeout: 'COMMAND_TIMEOUT',
  /** The plugin build and the bridge disagree about the wire format. */
  ProtocolMismatch: 'PROTOCOL_MISMATCH',
  /** The request body could not be parsed as a poll. */
  BadRequest: 'BAD_REQUEST',
  /** The bridge itself failed. */
  BridgeError: 'BRIDGE_ERROR',
} as const;

export type BridgeErrorCodeValue =
  (typeof BridgeErrorCode)[keyof typeof BridgeErrorCode];

/** Build a `CommandError` without repeating the object shape at each site. */
export function commandError(
  code: string,
  message: string,
  hint?: string,
  details?: unknown,
): CommandError {
  const error: CommandError = { code, message };
  if (hint !== undefined) error.hint = hint;
  if (details !== undefined) error.details = details;
  return error;
}

/** Build a failed `CommandResult`. */
export function failedResult(
  id: string,
  error: CommandError,
  durationMs = 0,
): CommandResult {
  return { id, ok: false, error, durationMs };
}

/**
 * Narrow an unknown value to a poll request.
 *
 * Deliberately permissive about the shape of `client`: a newer plugin build may
 * add fields, and a slightly odd identity is never a reason to drop a
 * connection. Only the fields the bridge actually relies on are checked.
 */
export function parsePollRequest(body: unknown): PollRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate['v'] !== 'number') return null;
  if (candidate['token'] !== null && typeof candidate['token'] !== 'string') {
    return null;
  }
  const client = candidate['client'];
  if (typeof client !== 'object' || client === null) return null;
  const results = candidate['results'];
  if (!Array.isArray(results)) return null;
  return {
    v: candidate['v'],
    token: candidate['token'] as string | null,
    client: normalizeIdentity(client as Record<string, unknown>),
    results: results.filter(isCommandResult),
  };
}

/** Fill in defaults so a partial identity from an older plugin still works. */
export function normalizeIdentity(raw: Record<string, unknown>): PluginIdentity {
  const str = (key: string, fallback: string): string =>
    typeof raw[key] === 'string' ? (raw[key] as string) : fallback;
  const nullable = (key: string): string | null =>
    typeof raw[key] === 'string' ? (raw[key] as string) : null;
  return {
    pluginVersion: str('pluginVersion', 'unknown'),
    // An older plugin build predates this field; "unstamped" is the honest answer
    // and still tells the reader the build identity cannot be trusted.
    buildId: str('buildId', 'unstamped'),
    apiVersion: str('apiVersion', 'unknown'),
    editorType: str('editorType', 'figma'),
    fileName: nullable('fileName'),
    pageName: str('pageName', 'unknown'),
    pageId: str('pageId', 'unknown'),
    selectionCount:
      typeof raw['selectionCount'] === 'number' ? raw['selectionCount'] : 0,
    commands: Array.isArray(raw['commands'])
      ? raw['commands'].filter((name): name is string => typeof name === 'string')
      : [],
  };
}

function isCommandResult(value: unknown): value is CommandResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['id'] === 'string' && typeof candidate['ok'] === 'boolean';
}

/* -------------------------------------------------------------------------
 * Write operations
 *
 * The write surface is deliberately semantic rather than a thin wrapper over
 * the Figma API: the model says `layout: { mode: 'HORIZONTAL', padding: 16 }`
 * and the plugin translates that into layoutMode / paddingLeft / … So the
 * vocabulary the model reads back from `describe` is the same one it writes
 * with, and a typo cannot silently set a property Figma will ignore.
 *
 * One `apply` call is one undo step: the plugin commits undo once per call, so
 * an agent that builds a screen cannot leave the user with forty undo presses.
 * ---------------------------------------------------------------------- */

export type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
export type Sizing = 'FIXED' | 'HUG' | 'FILL';
export type PrimaryAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
export type CounterAlign = 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
export type ChildAlign = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'INHERIT';
export type LayoutWrap = 'NO_WRAP' | 'WRAP';
export type TextAlignHorizontal = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
export type TextAlignVertical = 'TOP' | 'CENTER' | 'BOTTOM';
export type TextAutoResize = 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';

/** Node kinds `apply` can create. The rest are reached through `update`. */
export type CreatableNodeType = 'FRAME' | 'RECTANGLE' | 'ELLIPSE' | 'TEXT';

/** One colour fill. Hex only — a designer and a model both read `#rrggbb`. */
export interface PaintSpec {
  type: 'SOLID';
  /** `#rgb`, `#rrggbb`, or `#rrggbbaa` (the alpha channel is folded into opacity). */
  color: string;
  /** 0–1. Multiplied with any alpha present in `color`. */
  opacity?: number;
  /** Hide a paint without deleting it. */
  visible?: boolean;
}

/**
 * Auto-layout, in the same vocabulary `describe` reports.
 *
 * `sizing`, `grow`, and `align` describe how this node behaves **inside its
 * parent's** auto-layout, which is why they live here rather than in a separate
 * "position" concept — that is exactly how Figma models them.
 */
export interface LayoutSpec {
  mode?: LayoutMode;
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  itemSpacing?: number;
  counterAxisSpacing?: number;
  primaryAxisAlign?: PrimaryAlign;
  counterAxisAlign?: CounterAlign;
  wrap?: LayoutWrap;
  sizing?: { horizontal?: Sizing; vertical?: Sizing };
  grow?: number;
  align?: ChildAlign;
}

export interface TextStyleSpec {
  fontSize?: number;
  fontFamily?: string;
  fontStyle?: string;
  /** A number means pixels; `AUTO` means Figma's automatic line height. */
  lineHeight?: number | 'AUTO' | { value: number; unit: 'PIXELS' | 'PERCENT' };
  letterSpacing?: number | { value: number; unit: 'PIXELS' | 'PERCENT' };
  alignHorizontal?: TextAlignHorizontal;
  alignVertical?: TextAlignVertical;
  autoResize?: TextAutoResize;
  /** Shorthand for a single solid fill on the text. */
  color?: string;
}

export interface TextSpec extends TextStyleSpec {
  characters: string;
}

/** A node to create. `children` nests recursively, so one op can build a tree. */
export interface NodeSpec {
  type: CreatableNodeType;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layout?: LayoutSpec;
  /** `null` clears fills; omitted leaves them at whatever the node defaults to. */
  fills?: PaintSpec[] | null;
  strokes?: PaintSpec[] | null;
  strokeWeight?: number;
  cornerRadius?: number | { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  opacity?: number;
  visible?: boolean;
  clipsContent?: boolean;
  text?: TextSpec;
  children?: NodeSpec[];
}

/** Properties `update` may change on an existing node. */
export type NodePatch = Omit<NodeSpec, 'type' | 'children' | 'text'> & {
  /** Partial: an update may retarget the font without rewriting the characters. */
  text?: Partial<TextSpec>;
};

export type ApplyOp =
  | {
      op: 'create';
      /** Optional handle other ops (and the model) can refer to via `ref:id`. */
      ref?: string;
      /** Where to create it. Defaults to the current page. */
      parentId?: string;
      node: NodeSpec;
    }
  | { op: 'update'; id: string; props: NodePatch }
  | { op: 'move'; id: string; x?: number; y?: number; parentId?: string; index?: number }
  | { op: 'rename'; id: string; name: string }
  | { op: 'delete'; id: string };

/** What `apply` reports back, so the model can address what it just made. */
export interface ApplyResult {
  created: { ref: string | null; id: string; name: string; type: string }[];
  updated: string[];
  moved: string[];
  renamed: string[];
  deleted: string[];
  /** Font families actually loaded, including any fallback that was substituted. */
  fontsUsed: string[];
  notes: string[];
}

/* -------------------------------------------------------------------------
 * Design tokens (Figma Variables)
 *
 * The point of reading tokens is not bookkeeping: it is that a hard-coded value
 * and a token-bound value look identical in a screenshot and identical in
 * `describe` unless the binding is reported. `audit` exists to name the
 * difference — "this #1d2129 could be the variable Dark/Text/1" — which is what
 * turns a tidy-looking file into one that survives a theme change.
 * ---------------------------------------------------------------------- */

export type TokenAction = 'list' | 'create' | 'bind' | 'audit' | 'delete';

export type TokenVariableType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';

export interface TokenMode {
  modeId: string;
  name: string;
}

export interface TokenCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: TokenMode[];
  variableCount: number;
}

export interface TokenVariable {
  id: string;
  name: string;
  collectionId: string;
  collectionName: string;
  resolvedType: TokenVariableType;
  /** The value in the collection's default mode, rendered for reading. */
  value: string | number | boolean | null;
  description: string;
  /** Variable ids this one aliases, when it is an alias rather than a literal. */
  aliasesTo: string[];
  /**
   * Whether the variable lives in this file or in a library it consumes.
   *
   * Real design systems live in libraries, and a library variable cannot be
   * enumerated from the file — but it *can* be discovered from the nodes that
   * already use it, which is also the list worth having: the tokens this file
   * actually depends on.
   */
  source: 'local' | 'library';
  /** For a library variable, a node in this file that already uses it. */
  usedAt?: { nodeId: string; field: string };
}

/** A literal value that could be bound to a variable, with the candidate. */
export interface TokenAuditFinding {
  nodeId: string;
  nodeName: string;
  /** `fills[0]`, `strokes[0]`, `itemSpacing`, `cornerRadius`, … */
  field: string;
  /** The hard-coded value, rendered the way the model would read it back. */
  literal: string;
  /** A same-typed variable already holding exactly this value, if one exists. */
  candidateVariableId?: string;
  candidateVariableName?: string;
  /** Whether that candidate is local to this file or comes from a library. */
  candidateVariableSource?: 'local' | 'library';
}

export interface TokenBindRequest {
  /**
   * Node to bind on. May be an id *path* — `885:1923/76:646/80:825` — which is
   * the only way to address a layer inside an instance, since such a layer's own
   * id (`I…;…;…`) is rejected by Figma's id lookup.
   */
  nodeId: string;
  /**
   * `fills` / `strokes` bind one paint via `setBoundVariableForPaint`; anything
   * else must be a Figma variable-bindable node field such as `itemSpacing`,
   * `paddingLeft`, `cornerRadius`, `width`, `opacity`, or `strokeWeight`.
   */
  field: string;
  variableId: string;
  /** Which paint to bind when `field` is `fills` or `strokes`. Defaults to 0. */
  paintIndex?: number;
}

export interface TokenCreateRequest {
  /** Name of a new collection to create. Mutually exclusive with `collectionId`. */
  collection?: string;
  /** Existing collection to add into. */
  collectionId?: string;
  variables: {
    name: string;
    type: TokenVariableType;
    /** COLOR takes `#rrggbb` / `#rrggbbaa`; FLOAT a number; STRING text; BOOLEAN a boolean. */
    value: string | number | boolean;
    description?: string;
  }[];
}

/** What `tokens` reports back, shaped per action. */
export interface TokensResult {
  action: TokenAction;
  collections: TokenCollection[];
  variables: TokenVariable[];
  /** `bind` only: bindings that took effect. */
  bound: TokenBindRequest[];
  /** `create` only: what was created. */
  createdVariables: TokenVariable[];
  createdCollection?: TokenCollection;
  /** `audit` only: literals that a variable could replace. */
  findings: TokenAuditFinding[];
  /** `delete` only: what was removed, by id. */
  deletedVariables: string[];
  deletedCollections: string[];
  /** Nodes the action looked at, so the model knows the scope it was given. */
  scannedNodeIds: string[];
  notes: string[];
}
