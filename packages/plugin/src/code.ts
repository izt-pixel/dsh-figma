/**
 * DSH Figma Bridge — the plugin main thread (canvas layer).
 *
 * ## Why this file is a single module with no runtime imports
 *
 * Figma loads `main` as one classic script: there is no module loader and bare
 * specifiers cannot be resolved. So `@dsh-figma/protocol` is imported with
 * `import type` only — which TypeScript erases completely — and the handful of
 * shared runtime constants are mirrored below. `scripts/verify-bundle.mjs`
 * fails the build if an `import`/`export`/`require` ever survives into the
 * emitted file.
 *
 * ## Why long polling
 *
 * `@figma/plugin-typings/index.d.ts` declares the sandbox globals and they are
 * exactly: `figma`, `__html__`, `__uiFiles__`, `console`, `setTimeout`,
 * `clearTimeout`, `setInterval`, `clearInterval`, and `fetch`. There is no
 * `WebSocket`, no `window`, and no `localStorage`, and a plugin cannot accept
 * inbound connections. The plugin therefore pulls work by long-polling the
 * bridge, carrying the previous batch's results on the next request.
 */

/*
 * The wire types (`PluginIdentity`, `CommandRequest`, `CommandResult`,
 * `PollRequest`, `PollResponse`, `CommandError`) are ambient here — see
 * `src/protocol-types.d.ts`, which lifts them from `@dsh-figma/protocol`
 * without making this file a module. This file deliberately contains no
 * `import` or `export` of any kind, because Figma loads it as a classic script.
 */

/* -------------------------------------------------------------------------
 * Mirrors of @dsh-figma/protocol
 *
 * These MUST stay in sync with packages/protocol/src/index.ts. The bridge
 * validates `v` strictly and answers 409 PROTOCOL_MISMATCH, so drift shows up
 * as an explicit message in the plugin panel instead of a silent hang.
 * ---------------------------------------------------------------------- */

const PROTOCOL_VERSION = 1;
const DEFAULT_BRIDGE_PORT = 8790;

/** Shared budgets — see the same names in packages/protocol/src/index.ts. */
const MAX_IMAGES_PER_RESULT = 4;
const MAX_IMAGE_PIXELS = 1_600_000;
const MAX_DESCRIBE_NODES = 400;
const MAX_DESCRIBE_DEPTH = 8;
const MAX_TEXT_PREVIEW_CHARS = 200;

const PLUGIN_VERSION = '0.1.0';

/**
 * Replaced with a hash of the compiled bundle by `scripts/stamp-build.mjs`.
 *
 * Until that runs, this literal is what ships — and "unstamped" is exactly the
 * right answer in that case, because an unstamped bundle has no verifiable
 * identity. Kept as a plain literal so `tsc` can leave it alone and the stamp
 * step stays a two-line substitution with no bundler involved.
 */
const BUILD_ID = '__BUILD_ID__';

const STORAGE_KEY_PORT = 'dsh-figma.bridgePort';
const STORAGE_KEY_TOKEN = 'dsh-figma.bridgeToken';

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** How many log lines the panel keeps. */
const LOG_LIMIT = 14;

/** Selection entries reported by `status` before it starts truncating. */
const SELECTION_LIMIT = 20;

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

type LinkState = 'connecting' | 'connected' | 'offline' | 'error';

/* -------------------------------------------------------------------------
 * Panel state
 * ---------------------------------------------------------------------- */

let running = true;
let port = DEFAULT_BRIDGE_PORT;
let token: string | null = null;

/** Results queued for the next poll; only cleared once the bridge has them. */
let outgoingResults: CommandResult[] = [];

let failures = 0;
let commandCount = 0;
let linkState: LinkState = 'connecting';
let linkDetail = 'Starting up…';
const logLines: string[] = [];

function postState(): void {
  try {
    figma.ui.postMessage({
      type: 'state',
      state: linkState,
      detail: linkDetail,
      port,
      protocolVersion: PROTOCOL_VERSION,
      pluginVersion: PLUGIN_VERSION,
      buildId: BUILD_ID,
      paired: token !== null,
      commandCount,
      identity: readIdentity(),
      log: logLines,
    });
  } catch {
    // The panel can be gone while the plugin is still winding down.
  }
}

function note(line: string): void {
  logLines.unshift(`${new Date().toLocaleTimeString()}  ${line}`);
  if (logLines.length > LOG_LIMIT) logLines.length = LOG_LIMIT;
}

function setLink(state: LinkState, detail: string): void {
  linkState = state;
  linkDetail = detail;
  postState();
}

/* -------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------- */

/** Read a value that may throw or be unavailable, without failing the poll. */
function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function readIdentity(): PluginIdentity {
  // Every read here is best-effort, including `figma.currentPage` itself: Figma
  // disables its API the moment the plugin starts closing, and an unguarded
  // throw would take down the poll loop instead of just degrading one report.
  const page = attempt(() => figma.currentPage, null);
  return {
    pluginVersion: PLUGIN_VERSION,
    buildId: BUILD_ID,
    apiVersion: attempt(() => figma.apiVersion, 'unknown'),
    editorType: attempt(() => figma.editorType, 'figma'),
    // `figma.root.name` is the file name.
    fileName: attempt(() => figma.root.name, null),
    pageName: page === null ? 'unknown' : attempt(() => page.name, 'unknown'),
    pageId: page === null ? 'unknown' : attempt(() => page.id, 'unknown'),
    selectionCount: page === null ? 0 : attempt(() => page.selection.length, 0),
    commands: Object.keys(handlers),
  };
}

/* -------------------------------------------------------------------------
 * Reading Figma values
 *
 * Everything below reads node properties through a loose `Record<string, …>`
 * view of the node rather than through the typed API. That is deliberate: a
 * property can legally be `figma.mixed` on a text node, absent on a node type
 * that does not implement the mixin, or throw once the node has been removed by
 * the user. Going through plain property reads with type guards keeps one
 * defensive shape instead of a dozen casts.
 * ---------------------------------------------------------------------- */

function numberAt(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringAt(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The literal used wherever Figma's `mixed` symbol appears in the output.
 *
 * `figma.mixed` is a unique symbol, not a value: it means "the runs of this text
 * node disagree" (a mixed font size, a mixed fill). That is an *answer*, so it
 * is reported as this string. Omitting the property instead would assert
 * something different and false — that the node has no such property at all —
 * and a model editing text would then skip a property that is really there.
 */
const MIXED = 'mixed';

/** Whether a property read came back as Figma's `mixed` symbol. */
function isMixed(value: unknown): boolean {
  return value === (figma.mixed as unknown);
}

/** Like {@link numberAt}, but reports `mixed` rather than hiding it. */
function mixedNumberAt(
  raw: Record<string, unknown>,
  key: string,
): number | typeof MIXED | undefined {
  const value = raw[key];
  if (isMixed(value)) return MIXED;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Like {@link stringAt}, but reports `mixed` rather than hiding it. */
function mixedStringAt(
  raw: Record<string, unknown>,
  key: string,
): string | typeof MIXED | undefined {
  const value = raw[key];
  if (isMixed(value)) return MIXED;
  return typeof value === 'string' ? value : undefined;
}

function rawOf(node: BaseNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

function nameOf(node: BaseNode): string {
  return attempt(() => node.name, 'unknown');
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Whether an id belongs to a layer inside an instance.
 *
 * Figma gives those synthetic ids of the form `I<instance>;<component>;<node>`,
 * and `getNodeByIdAsync` refuses them: they can only be reached by walking down
 * from the instance. Handing one out as if it were addressable, with an error
 * hint that blames a recreated node, sends the reader after the wrong cause.
 */
function isInstanceScopedId(id: string): boolean {
  return id.startsWith('I') && id.includes(';');
}

/**
 * The id path that addresses this node, for a node whose own id will not resolve.
 *
 * A synthetic id's segments are component node ids, not tree levels — `I885:1923;
 * 80:825;78:672` sits five levels deep in the tree — so a reader cannot derive a
 * usable path from the id it was given. Handing the path over is the difference
 * between "you cannot address this" and "here is the address".
 *
 * Each step contributes the trailing segment of the id, which is what sibling
 * matching needs, and the walk stops at the first normally-addressable ancestor.
 */
function addressPathOf(node: BaseNode): string | null {
  const segments: string[] = [];
  let current: BaseNode | null | undefined = node;
  let anchored = false;
  while (current != null) {
    const id = current.id;
    const isSynthetic = id.includes(';');
    segments.unshift(isSynthetic ? id.slice(id.lastIndexOf(';') + 1) : id);
    if (!isSynthetic) {
      anchored = true;
      break;
    }
    current = current.parent;
  }
  // Only an anchored path can be resolved: the first segment has to be a real id,
  // because it is the one `getNodeByIdAsync` is handed. Returning an unanchored
  // one would be handing out an address that cannot work — the exact failure
  // this function exists to prevent.
  return anchored && segments.length > 1 ? segments.join('/') : null;
}

/** Shared explanation for an id that will not resolve. */
const NODE_ID_HINT =
  'Ids change when a node is recreated. A layer inside an instance is the awkward case: its own id starts with "I" and Figma rejects it, so address it by the `addressPath` that describe reports for it — a path of ids from the instance, like "885:1923/18:3171/89:1724/80:825/78:673".';

/** A structured, model-readable failure. `execute` turns this into a CommandError. */
function fail(code: string, message: string, hint?: string): never {
  throw { code, message, hint };
}

/**
 * Fail while carrying evidence.
 *
 * A write batch that stops halfway must hand back what it already did: the user
 * can see those nodes on the canvas, so pretending nothing happened would leave
 * the model reasoning about a document state that no longer exists.
 */
function failWith(code: string, message: string, hint: string | undefined, details: unknown): never {
  throw { code, message, hint, details };
}

/* -------------------------------------------------------------------------
 * Colour and paint
 * ---------------------------------------------------------------------- */

/** Figma stores colours as 0–1 floats; hex is what a designer and a model both read. */
function colorToHex(color: { r: number; g: number; b: number }): string {
  const channel = (value: number): string => {
    const byte = Math.round(Math.min(Math.max(value, 0), 1) * 255);
    return (byte < 16 ? '0' : '') + byte.toString(16);
  };
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function isRgbLike(value: unknown): value is { r: number; g: number; b: number } {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['r'] === 'number' &&
    typeof candidate['g'] === 'number' &&
    typeof candidate['b'] === 'number'
  );
}

function serializePaint(paint: Paint): Record<string, unknown> {
  const raw = paint as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { type: raw['type'] };

  if (raw['visible'] === false) out['visible'] = false;
  const opacity = numberAt(raw, 'opacity');
  if (opacity !== undefined && opacity !== 1) out['opacity'] = round(opacity, 3);

  const color = raw['color'];
  if (isRgbLike(color)) out['color'] = colorToHex(color);

  const stops = raw['gradientStops'];
  if (Array.isArray(stops)) {
    out['stops'] = stops.map((stop) => {
      const entry = stop as { position?: unknown; color?: unknown };
      return {
        at: typeof entry.position === 'number' ? round(entry.position, 3) : 0,
        color: isRgbLike(entry.color) ? colorToHex(entry.color) : null,
      };
    });
  }

  const scaleMode = stringAt(raw, 'scaleMode');
  if (scaleMode !== undefined) out['scaleMode'] = scaleMode;
  const imageHash = stringAt(raw, 'imageHash');
  if (imageHash !== undefined) out['imageHash'] = imageHash;

  // A palette that is driven by variables must read as such, or the model will
  // happily replace a token with a hard-coded hex and break the design system.
  const bound = raw['boundVariables'];
  if (bound !== null && typeof bound === 'object') {
    const id = (bound as { color?: { id?: unknown } }).color?.id;
    if (typeof id === 'string') out['variableId'] = id;
  }

  return out;
}

function serializePaints(
  raw: Record<string, unknown>,
  key: string,
): unknown[] | typeof MIXED | undefined {
  const value = raw[key];
  // A text node whose runs have different colours returns `mixed` for `fills`.
  // Reporting that beats dropping the key: the node genuinely has fills, they
  // just are not one value.
  if (isMixed(value)) return MIXED;
  if (!Array.isArray(value)) return undefined;
  return value.map((paint) => serializePaint(paint as Paint));
}

/* -------------------------------------------------------------------------
 * Layout, text, and variable bindings
 * ---------------------------------------------------------------------- */

/** Auto-layout, reported in Figma's own vocabulary so a write can match it. */
function serializeLayout(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const mode = stringAt(raw, 'layoutMode');
  if (mode === undefined || mode === 'NONE') return undefined;

  const layout: Record<string, unknown> = { mode };

  const itemSpacing = numberAt(raw, 'itemSpacing');
  if (itemSpacing !== undefined) layout['itemSpacing'] = itemSpacing;
  const counterAxisSpacing = numberAt(raw, 'counterAxisSpacing');
  if (counterAxisSpacing !== undefined) layout['counterAxisSpacing'] = counterAxisSpacing;

  const padding: Record<string, number> = {};
  const paddingFields = [
    ['top', 'paddingTop'],
    ['right', 'paddingRight'],
    ['bottom', 'paddingBottom'],
    ['left', 'paddingLeft'],
  ] as const;
  for (const [side, field] of paddingFields) {
    const value = numberAt(raw, field);
    if (value !== undefined && value !== 0) padding[side] = value;
  }
  if (Object.keys(padding).length > 0) layout['padding'] = padding;

  const primary = stringAt(raw, 'primaryAxisAlignItems');
  if (primary !== undefined) layout['primaryAxisAlign'] = primary;
  const counter = stringAt(raw, 'counterAxisAlignItems');
  if (counter !== undefined) layout['counterAxisAlign'] = counter;
  const wrap = stringAt(raw, 'layoutWrap');
  if (wrap !== undefined && wrap !== 'NO_WRAP') layout['wrap'] = wrap;

  const sizingHorizontal = stringAt(raw, 'layoutSizingHorizontal');
  if (sizingHorizontal !== undefined) layout['sizingHorizontal'] = sizingHorizontal;
  const sizingVertical = stringAt(raw, 'layoutSizingVertical');
  if (sizingVertical !== undefined) layout['sizingVertical'] = sizingVertical;

  const grow = numberAt(raw, 'layoutGrow');
  if (grow !== undefined && grow !== 0) layout['grow'] = grow;
  const align = stringAt(raw, 'layoutAlign');
  if (align !== undefined && align !== 'INHERIT') layout['align'] = align;

  return layout;
}

function serializeText(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const characters = raw['characters'];
  if (typeof characters !== 'string') return undefined;

  const text: Record<string, unknown> = {
    characters:
      characters.length > MAX_TEXT_PREVIEW_CHARS
        ? `${characters.slice(0, MAX_TEXT_PREVIEW_CHARS)}…`
        : characters,
  };
  if (characters.length > MAX_TEXT_PREVIEW_CHARS) text['charactersTruncated'] = true;

  // Every typographic property can be `figma.mixed` on a node whose runs
  // disagree. Each one is reported as `mixed` rather than dropped, so the model
  // learns that the property exists and varies — which is a different fact from
  // its being absent, and the one that decides whether an edit is safe.
  const fontSize = mixedNumberAt(raw, 'fontSize');
  if (fontSize !== undefined) text['fontSize'] = fontSize;

  const fontName = raw['fontName'];
  if (isMixed(fontName)) {
    text['fontName'] = MIXED;
  } else if (fontName !== null && typeof fontName === 'object') {
    const family = (fontName as { family?: unknown }).family;
    const style = (fontName as { style?: unknown }).style;
    if (typeof family === 'string') {
      text['fontFamily'] = family;
      if (typeof style === 'string') text['fontStyle'] = style;
    }
  }

  const lineHeight = raw['lineHeight'];
  if (isMixed(lineHeight)) {
    text['lineHeight'] = MIXED;
  } else if (lineHeight !== null && typeof lineHeight === 'object') {
    const unit = (lineHeight as { unit?: unknown }).unit;
    const value = (lineHeight as { value?: unknown }).value;
    text['lineHeight'] =
      unit === 'AUTO' || typeof value !== 'number' ? unit ?? null : { value, unit };
  }

  const letterSpacing = raw['letterSpacing'];
  if (isMixed(letterSpacing)) {
    text['letterSpacing'] = MIXED;
  } else if (letterSpacing !== null && typeof letterSpacing === 'object') {
    const unit = (letterSpacing as { unit?: unknown }).unit;
    const value = (letterSpacing as { value?: unknown }).value;
    if (typeof value === 'number') text['letterSpacing'] = { value, unit };
  }

  const alignHorizontal = mixedStringAt(raw, 'textAlignHorizontal');
  if (alignHorizontal !== undefined) text['alignHorizontal'] = alignHorizontal;
  const alignVertical = mixedStringAt(raw, 'textAlignVertical');
  if (alignVertical !== undefined) text['alignVertical'] = alignVertical;
  const autoResize = stringAt(raw, 'textAutoResize');
  if (autoResize !== undefined) text['autoResize'] = autoResize;

  return text;
}

/** Field → variable id, so the model can tell a token from a hard-coded value. */
function serializeVariableBindings(
  raw: Record<string, unknown>,
): Record<string, string> | undefined {
  const bound = raw['boundVariables'];
  if (bound === null || typeof bound !== 'object') return undefined;

  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(bound as Record<string, unknown>)) {
    // Multi-value fields (fills, strokes) bind as arrays of aliases.
    const alias = Array.isArray(value) ? value[0] : value;
    if (alias === null || typeof alias !== 'object') continue;
    const id = (alias as { id?: unknown }).id;
    if (typeof id === 'string') out[field] = id;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* -------------------------------------------------------------------------
 * Node serialization
 * ---------------------------------------------------------------------- */

interface DescribeBudget {
  /** Nodes the result may still spend. Shared across the whole traversal. */
  remaining: number;
  /**
   * Cut because the requested `depth` ran out. A different fact from hitting the
   * node budget, and it needs a different fix from the reader (raise `depth`
   * versus narrow the scope), so the two are tracked apart.
   */
  depthLimited: boolean;
  /** Cut because the node budget ran out. */
  countLimited: boolean;
}

function serializeNode(
  node: BaseNode,
  depth: number,
  budget: DescribeBudget,
): Record<string, unknown> {
  budget.remaining -= 1;
  const raw = rawOf(node);

  // Reading any property of a removed node throws, and a plugin that stays open
  // while the user edits will meet one sooner or later.
  if (node.removed) return { id: node.id, removed: true };

  const out: Record<string, unknown> = { id: node.id, name: nameOf(node), type: node.type };
  // Flag the ids a write tool cannot accept, and hand over the address that
  // works instead — the id's segments are component node ids, not tree levels,
  // so the path cannot be reconstructed from the id.
  if (isInstanceScopedId(node.id)) {
    out['instanceScoped'] = true;
    const path = addressPathOf(node);
    if (path !== null) out['addressPath'] = path;
  }

  const x = numberAt(raw, 'x');
  if (x !== undefined) out['x'] = round(x, 2);
  const y = numberAt(raw, 'y');
  if (y !== undefined) out['y'] = round(y, 2);
  const width = numberAt(raw, 'width');
  if (width !== undefined) out['width'] = round(width, 2);
  const height = numberAt(raw, 'height');
  if (height !== undefined) out['height'] = round(height, 2);

  const visible = raw['visible'];
  if (isMixed(visible)) out['visible'] = MIXED;
  else if (visible === false) out['visible'] = false;

  const opacity = mixedNumberAt(raw, 'opacity');
  if (opacity === MIXED) out['opacity'] = MIXED;
  else if (opacity !== undefined && opacity !== 1) out['opacity'] = round(opacity, 3);

  // `cornerRadius` is `mixed` whenever a node's corners differ — a very common
  // state, and previously the node simply looked like it had no radius at all.
  const cornerRadius = mixedNumberAt(raw, 'cornerRadius');
  if (cornerRadius === MIXED) out['cornerRadius'] = MIXED;
  else if (cornerRadius !== undefined && cornerRadius !== 0) out['cornerRadius'] = cornerRadius;

  const layout = serializeLayout(raw);
  if (layout !== undefined) out['layout'] = layout;

  const fills = serializePaints(raw, 'fills');
  if (fills !== undefined) out['fills'] = fills;
  const strokes = serializePaints(raw, 'strokes');
  const strokeExists = strokes === MIXED || (Array.isArray(strokes) && strokes.length > 0);
  if (strokes === MIXED) out['strokes'] = MIXED;
  else if (strokeExists) out['strokes'] = strokes;

  /*
   * Report the weight exactly when there is a stroke for it to apply to, and
   * never otherwise.
   *
   * `strokeWeight` is `mixed` when the sides disagree, and 0 when the stroke
   * exists but is switched off. Omitting a zero weight while still reporting the
   * `strokes` array implies Figma's default weight of 1 — so the node reads as
   * stroked in the data and draws nothing on the canvas. Conversely, reporting a
   * weight on a node with no strokes is noise that every node carries. Both
   * cases are the same failure: a field whose presence contradicts the array
   * beside it.
   */
  const strokeWeight = mixedNumberAt(raw, 'strokeWeight');
  if (strokeWeight === MIXED) out['strokeWeight'] = MIXED;
  else if (strokeExists && strokeWeight !== undefined) out['strokeWeight'] = strokeWeight;

  const text = serializeText(raw);
  if (text !== undefined) out['text'] = text;

  const componentId = stringAt(raw, 'componentId');
  if (componentId !== undefined) out['componentId'] = componentId;

  const variables = serializeVariableBindings(raw);
  if (variables !== undefined) out['variables'] = variables;

  const children = raw['children'];
  if (Array.isArray(children)) {
    if (depth <= 0) {
      out['childrenOmitted'] = children.length;
      budget.depthLimited = true;
    } else if (budget.remaining <= 0) {
      out['childrenOmitted'] = children.length;
      budget.countLimited = true;
    } else {
      const serialized: unknown[] = [];
      for (const child of children as BaseNode[]) {
        if (budget.remaining <= 0) {
          out['childrenOmitted'] = children.length - serialized.length;
          budget.countLimited = true;
          break;
        }
        serialized.push(serializeNode(child, depth - 1, budget));
      }
      out['children'] = serialized;
    }
  }

  return out;
}

/** Apply a `fields` projection at every level of the tree. */
function projectNode(
  node: Record<string, unknown>,
  fields: string[] | null,
): Record<string, unknown> {
  if (fields === null || fields.length === 0) return node;

  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = node[field];
    if (value === undefined) continue;
    out[field] = field === 'children' && Array.isArray(value)
      ? value.map((child) => projectNode(child as Record<string, unknown>, fields))
      : value;
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Image export
 * ---------------------------------------------------------------------- */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 without `btoa`.
 *
 * The plugin sandbox's declared globals are `figma`, `fetch`, `console`, the
 * four timer functions, `__html__`, and `__uiFiles__` — `btoa`, `atob`, and
 * `TextEncoder` are browser APIs that are NOT among them. Encoding by hand costs
 * twenty lines and removes the dependency (and any doubt) entirely.
 */
function base64FromBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0;
    const b1 = bytes[index + 1] ?? 0;
    const b2 = bytes[index + 2] ?? 0;

    chunk += BASE64_ALPHABET.charAt(b0 >> 2);
    chunk += BASE64_ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    chunk +=
      index + 1 < bytes.length ? BASE64_ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : '=';
    chunk += index + 2 < bytes.length ? BASE64_ALPHABET.charAt(b2 & 0x3f) : '=';

    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  if (chunk !== '') parts.push(chunk);
  return parts.join('');
}

/**
 * Largest scale at or below the requested one that fits the pixel budget.
 *
 * Exceeding the budget is not merely slow: every pixel becomes visual tokens in
 * the model's context, and an oversized export is what turns a helpful
 * screenshot into a rejected one.
 */
function effectiveScale(width: number, height: number, requested: number): number {
  const wanted = clampNumber(requested, 0.25, 4, 2);
  const area = width * height;
  if (!(area > 0)) return wanted;
  if (area * wanted * wanted <= MAX_IMAGE_PIXELS) return round(wanted, 2);
  return round(Math.max(0.25, Math.min(wanted, Math.sqrt(MAX_IMAGE_PIXELS / area))), 2);
}

/* -------------------------------------------------------------------------
 * Command handlers
 *
 * This registry is the plugin's whole capability surface. Later phases add
 * `apply`, `text`, `tokens`, `components`, `export`, and a sandboxed `script`
 * escape hatch. `describe` and `screenshot` are the read half: `describe` says
 * what the document claims, `screenshot` shows what the user sees, and the gap
 * between the two is where design bugs live.
 * ---------------------------------------------------------------------- */

const handlers: Record<string, Handler> = {
  status() {
    const page = figma.currentPage;
    const selection = attempt(() => page.selection, []);
    return {
      pluginVersion: PLUGIN_VERSION,
      buildId: BUILD_ID,
      protocolVersion: PROTOCOL_VERSION,
      apiVersion: figma.apiVersion,
      editorType: figma.editorType,
      mode: figma.mode,
      fileName: attempt(() => figma.root.name, null),
      page: { id: attempt(() => page.id, 'unknown'), name: attempt(() => page.name, 'unknown') },
      pages: attempt(
        () => figma.root.children.slice(0, 50).map((entry) => ({ id: entry.id, name: entry.name })),
        [],
      ),
      selection: selection.slice(0, SELECTION_LIMIT).map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        removed: node.removed,
      })),
      selectionTruncated: selection.length > SELECTION_LIMIT,
      documentAccess: 'dynamic-page',
      commands: Object.keys(handlers),
      bridge: { port, paired: token !== null, state: linkState },
    };
  },

  ping(args) {
    const echo = args['echo'];
    return {
      echo: typeof echo === 'string' ? echo : null,
      pluginTime: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      pageId: attempt(() => figma.currentPage.id, null),
    };
  },

  // Declared as hoisted functions below, so the registry stays a readable index
  // of what this build can do.
  describe: describeCommand,
  screenshot: screenshotCommand,
  apply: applyCommand,
  tokens: tokensCommand,
};

/* -------------------------------------------------------------------------
 * `describe` — the structured read
 * ---------------------------------------------------------------------- */

/**
 * Resolve one id, or an id *path*, to a node.
 *
 * A layer inside an instance carries a synthetic id — `I<instance>;<component>;
 * <node>` — that `getNodeByIdAsync` refuses outright. The only way to reach one
 * is to walk down from its instance, so a path of real ids separated by `/`
 * does exactly that: `885:1923/76:646/80:825/78:672`. Every segment after the
 * first is matched against the child's id suffix, because that is the only part
 * of an instance-scoped id the reader can see.
 */
async function resolveNodePath(id: string): Promise<BaseNode | null> {
  const segments = id.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return null;

  const head = segments[0] as string;
  const first = await figma.getNodeByIdAsync(head);
  if (first === null) return null;
  if (segments.length === 1) return first;

  let current: BaseNode = first;
  for (const segment of segments.slice(1)) {
    const children = rawOf(current)['children'];
    if (!Array.isArray(children)) return null;
    const candidates = children as BaseNode[];
    const exact = candidates.find((child) => child.id === segment);
    const suffixed = candidates.filter((child) => child.id.endsWith(`;${segment}`));
    if (exact !== undefined) {
      current = exact;
      continue;
    }
    // Ambiguity is refused rather than guessed: picking the wrong layer inside
    // an instance would silently edit the wrong thing.
    if (suffixed.length !== 1) return null;
    current = suffixed[0] as BaseNode;
  }
  return current;
}

/** Resolve explicit ids, reporting which ones no longer exist. */
async function resolveByIds(
  nodeIds: string[],
): Promise<{ nodes: BaseNode[]; missing: string[] }> {
  const nodes: BaseNode[] = [];
  const missing: string[] = [];
  for (const id of nodeIds) {
    const node = await resolveNodePath(id);
    if (node === null) missing.push(id);
    else nodes.push(node);
  }
  return { nodes, missing };
}

async function describeCommand(args: Record<string, unknown>): Promise<unknown> {
  const nodeIds = readStringArray(args['nodeIds']);
  const depth = clampInt(args['depth'], 0, MAX_DESCRIBE_DEPTH, 3);
  const limit = clampInt(args['limit'], 1, MAX_DESCRIBE_NODES, 200);
  const fields = Array.isArray(args['fields']) ? readStringArray(args['fields']) : null;

  const notes: string[] = [];
  let scope: string;
  let roots: BaseNode[];

  if (nodeIds.length > 0) {
    scope = 'nodeIds';
    const resolved = await resolveByIds(nodeIds);
    if (resolved.nodes.length === 0) {
      return fail(
        'NODE_NOT_FOUND',
        `None of the requested node ids exist any more: ${resolved.missing.join(', ')}.`,
        NODE_ID_HINT,
      );
    }
    roots = resolved.nodes;
    if (resolved.missing.length > 0) {
      notes.push(`These ids no longer exist and were skipped: ${resolved.missing.join(', ')}.`);
    }
  } else if (args['scope'] === 'page') {
    scope = 'page';
    roots = [...figma.currentPage.children];
  } else {
    scope = 'selection';
    roots = [...figma.currentPage.selection];
    if (roots.length === 0) {
      return fail(
        'EMPTY_SELECTION',
        'Nothing is selected in Figma right now.',
        'Select a layer in Figma, or pass nodeIds explicitly, or use scope "page" to read the current page\'s top-level nodes.',
      );
    }
  }

  const budget: DescribeBudget = { remaining: limit, depthLimited: false, countLimited: false };
  const total = roots.length;
  const nodes: Record<string, unknown>[] = [];
  for (const root of roots) {
    if (budget.remaining <= 0) {
      budget.countLimited = true;
      break;
    }
    nodes.push(projectNode(serializeNode(root, depth, budget), fields));
  }

  if (total > nodes.length) {
    notes.push(`${total - nodes.length} requested node(s) were dropped by the ${limit}-node limit.`);
  }
  // Say which limit was hit, because the fix differs: a deeper read versus a
  // narrower one. Reporting a single "truncated" flag told the model to fix
  // something that may not have been the problem.
  if (budget.depthLimited) {
    notes.push(
      `Some children were omitted because depth ${depth} was reached (look for "childrenOmitted"). Raise \`depth\`, or read the branch you care about by node id.` +
        // A projection that drops `children` looks identical to hitting the depth
        // limit, so the advice to raise `depth` alone would send the reader down
        // the wrong path.
        (fields === null
          ? ''
          : ' Note: `fields` also filters the output — include "children" in it, or the subtree is cut even when it was traversed.'),
    );
  }
  if (budget.countLimited) {
    notes.push(
      `The ${limit}-node budget ran out. Narrow the scope, read a subtree by node id, or use \`fields\` to shrink each node.`,
    );
  }

  const result: Record<string, unknown> = {
    scope,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    depth,
    nodeCount: nodes.length,
    truncated: budget.depthLimited || budget.countLimited,
    depthLimited: budget.depthLimited,
    countLimited: budget.countLimited,
    nodes,
  };
  if (notes.length > 0) result['notes'] = notes;
  return result;
}

/* -------------------------------------------------------------------------
 * `screenshot` — the visual half of the loop
 * ---------------------------------------------------------------------- */

interface ImagePayload {
  mimeType: string;
  base64: string;
  byteLength: number;
  width: number;
  height: number;
  nodeId: string;
  nodeName: string;
  scale: number;
}

interface SkippedCapture {
  nodeId: string;
  nodeName?: string;
  reason: string;
}

/** Pick what to capture: explicit ids, else the selection, else top-level frames. */
async function resolveCaptureTargets(
  nodeIds: string[],
  notes: string[],
): Promise<BaseNode[] | { error: unknown }> {
  if (nodeIds.length > 0) {
    const resolved = await resolveByIds(nodeIds);
    if (resolved.nodes.length === 0) {
      return {
        error: {
          code: 'NODE_NOT_FOUND',
          message: `None of the requested node ids exist any more: ${resolved.missing.join(', ')}.`,
          hint: 'Use describe with scope "page" to list the current top-level nodes.',
        },
      };
    }
    return resolved.nodes;
  }

  const selection = attempt(() => figma.currentPage.selection, []);
  if (selection.length > 0) return [...selection];

  const topLevel = [...figma.currentPage.children];
  if (topLevel.length === 0) {
    return {
      error: {
        code: 'NOTHING_TO_CAPTURE',
        message: 'Nothing is selected and the current page has no top-level nodes.',
        hint: 'Create a frame first, or select a layer in Figma and call screenshot again.',
      },
    };
  }
  notes.push(
    `Nothing was selected, so the page's first ${Math.min(topLevel.length, MAX_IMAGES_PER_RESULT)} top-level node(s) were exported. Pass nodeIds to choose precisely.`,
  );
  return topLevel;
}

async function screenshotCommand(args: Record<string, unknown>): Promise<unknown> {
  const nodeIds = readStringArray(args['nodeIds']);
  const requestedScale = clampNumber(args['scale'], 0.25, 4, 2);
  const format = args['format'] === 'JPG' ? 'JPG' : 'PNG';
  const mimeType = format === 'JPG' ? 'image/jpeg' : 'image/png';

  const notes: string[] = [];
  const targets = await resolveCaptureTargets(nodeIds, notes);
  if (!Array.isArray(targets)) return fail(
    (targets.error as { code: string }).code,
    (targets.error as { message: string }).message,
    (targets.error as { hint?: string }).hint,
  );

  const images: ImagePayload[] = [];
  const skipped: SkippedCapture[] = [];

  for (const node of targets) {
    if (images.length >= MAX_IMAGES_PER_RESULT) {
      notes.push(
        `${targets.length - images.length} further node(s) were not exported: at most ${MAX_IMAGES_PER_RESULT} images fit in one result. Export the containing frame instead, or call screenshot again.`,
      );
      break;
    }

    const label = nameOf(node);
    if (node.removed) {
      skipped.push({ nodeId: node.id, nodeName: label, reason: 'the node was removed' });
      continue;
    }

    const raw = rawOf(node);
    const exportAsync = raw['exportAsync'];
    if (typeof exportAsync !== 'function') {
      skipped.push({
        nodeId: node.id,
        nodeName: label,
        reason: `a ${node.type} node cannot be exported as an image`,
      });
      continue;
    }

    const width = numberAt(raw, 'width') ?? 0;
    const height = numberAt(raw, 'height') ?? 0;
    if (!(width > 0) || !(height > 0)) {
      skipped.push({
        nodeId: node.id,
        nodeName: label,
        reason: `zero-sized bounds (${width}x${height})`,
      });
      continue;
    }

    const scale = effectiveScale(width, height, requestedScale);
    try {
      const bytes = await (exportAsync as ExportFn).call(node, {
        format,
        constraint: { type: 'SCALE', value: scale },
      });
      if (bytes.length === 0) {
        skipped.push({ nodeId: node.id, nodeName: label, reason: 'Figma returned no image bytes' });
        continue;
      }
      images.push({
        mimeType,
        base64: base64FromBytes(bytes),
        byteLength: bytes.length,
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        nodeId: node.id,
        nodeName: label,
        scale,
      });
    } catch (error) {
      skipped.push({ nodeId: node.id, nodeName: label, reason: message(error) });
    }
  }

  return { images, skipped, notes };
}

/** The structural slice of `exportAsync` this plugin relies on. */
type ExportFn = (settings: ExportSettings) => Promise<Uint8Array>;

/* -------------------------------------------------------------------------
 * `apply` — the write half of the loop
 *
 * Design rules, in order of how much they matter:
 *
 * 1. **Reject typos, never ignore them.** Every level validates its keys against
 *    a whitelist. A silently ignored `paddding: 16` would leave the model
 *    believing it set padding, and the mistake would surface as a mystery
 *    layout bug later — in a document that a human then has to repair.
 * 2. **One call, one undo step.** `commitUndo()` runs once per batch.
 * 3. **Semantic vocabulary.** `layout: { mode, padding, itemSpacing }` is
 *    translated here into Figma's own properties, so the words the model reads
 *    from `describe` are the words it writes with.
 * 4. **Partial failure reports its progress.** A batch that dies on op 3 of 5
 *    hands back the two nodes it already created, because they are on the
 *    canvas whether or not the caller is told about them.
 * ---------------------------------------------------------------------- */

/** Accepted keys per level. Kept next to the writers so they cannot drift. */
const OP_KEYS: Record<string, readonly string[]> = {
  create: ['op', 'ref', 'parentId', 'node'],
  update: ['op', 'id', 'props'],
  move: ['op', 'id', 'x', 'y', 'parentId', 'index'],
  rename: ['op', 'id', 'name'],
  delete: ['op', 'id'],
};
const NODE_KEYS = [
  'type', 'name', 'x', 'y', 'width', 'height', 'layout', 'fills', 'strokes',
  'strokeWeight', 'cornerRadius', 'opacity', 'visible', 'clipsContent', 'text', 'children',
] as const;
const LAYOUT_KEYS = [
  'mode', 'padding', 'itemSpacing', 'counterAxisSpacing', 'primaryAxisAlign',
  'counterAxisAlign', 'wrap', 'sizing', 'grow', 'align',
] as const;
const SIZING_KEYS = ['horizontal', 'vertical'] as const;
const PADDING_KEYS = ['top', 'right', 'bottom', 'left'] as const;
const PAINT_KEYS = ['type', 'color', 'opacity', 'visible'] as const;
const RADIUS_KEYS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const;
const TEXT_KEYS = [
  'characters', 'fontSize', 'fontFamily', 'fontStyle', 'lineHeight',
  'letterSpacing', 'alignHorizontal', 'alignVertical', 'autoResize', 'color',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Refuse unknown keys rather than dropping them on the floor. */
function rejectUnknownKeys(
  where: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  fail(
    'UNKNOWN_PROPERTY',
    `${where} has no propert${unknown.length === 1 ? 'y' : 'ies'} ${unknown.map((key) => `"${key}"`).join(', ')}.`,
    `Accepted here: ${allowed.join(', ')}. Nothing was changed by this op — remove or rename the unknown key.`,
  );
}

function readObject(where: string, value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) fail('BAD_OP', `${where} must be an object.`);
  return value;
}

function requireString(where: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('BAD_OP', `${where} must be a non-empty string.`);
  return value;
}

function optionalNumber(where: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('BAD_OP', `${where} must be a finite number.`);
  }
  return value;
}

/** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` into Figma's 0–1 channels plus alpha. */
function parseColor(where: string, hex: string): { color: RGB; alpha: number } {
  const raw = hex.startsWith('#') ? hex.slice(1) : hex;
  const expanded =
    raw.length === 3
      ? raw.split('').map((character) => character + character).join('')
      : raw;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(expanded)) {
    fail(
      'BAD_COLOR',
      `${where}: "${hex}" is not a colour.`,
      'Use "#rgb", "#rrggbb", or "#rrggbbaa" — for example "#722ed1".',
    );
  }
  const byte = (index: number): number => parseInt(expanded.slice(index, index + 2), 16) / 255;
  const alpha = expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1;
  return { color: { r: byte(0), g: byte(2), b: byte(4) }, alpha };
}

function toPaints(where: string, value: unknown): SolidPaint[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) fail('BAD_OP', `${where} must be an array of paints, or null to clear them.`);
  return value.map((entry, index) => {
    const spec = readObject(`${where}[${index}]`, entry);
    rejectUnknownKeys(`${where}[${index}]`, spec, PAINT_KEYS);
    if (spec['type'] !== undefined && spec['type'] !== 'SOLID') {
      fail('UNSUPPORTED_PAINT', `${where}[${index}].type is "${String(spec['type'])}".`, 'Only "SOLID" fills are supported for now. Use describe to read gradients verbatim from existing nodes.');
    }
    const parsed = parseColor(`${where}[${index}].color`, requireString(`${where}[${index}].color`, spec['color']));
    const opacity = optionalNumber(`${where}[${index}].opacity`, spec['opacity']);
    const combined = parsed.alpha * (opacity ?? 1);
    // Figma's paint fields are readonly, so the object is assembled as a record
    // and cast once instead of being mutated field by field.
    const paint: Record<string, unknown> = { type: 'SOLID', color: parsed.color };
    if (combined < 1) paint['opacity'] = combined;
    if (spec['visible'] === false) paint['visible'] = false;
    return paint as unknown as SolidPaint;
  });
}

/* ---------------------------- fonts ---------------------------------- */

/**
 * Families tried when the requested font is not installed.
 *
 * A missing font is the single most common way a text write fails, and Figma's
 * error ("Cannot load font") says nothing about what to do instead. The chain
 * ends at whatever the node already uses, so a write never *has* to fail just
 * because the family is unavailable — but the substitution is always reported.
 */
const FONT_FALLBACKS = ['Inter', 'Noto Sans SC', 'Arial'] as const;

interface FontContext {
  loaded: Set<string>;
  substitutions: string[];
}

function fontKey(font: FontName): string {
  return `${font.family} ${font.style}`;
}

async function loadFontOnce(font: FontName, context: FontContext): Promise<FontName> {
  await figma.loadFontAsync(font);
  context.loaded.add(fontKey(font));
  return font;
}

/** Load the requested font, falling back, and record any substitution made. */
async function resolveFont(
  requested: FontName,
  context: FontContext,
): Promise<FontName> {
  try {
    return await loadFontOnce(requested, context);
  } catch {
    // Fall through to the chain below.
  }
  for (const family of FONT_FALLBACKS) {
    for (const style of [requested.style, 'Regular']) {
      try {
        const substituted = await loadFontOnce({ family, style }, context);
        context.substitutions.push(
          `${requested.family} ${requested.style} is not available; used ${family} ${style} instead`,
        );
        return substituted;
      } catch {
        // Try the next candidate.
      }
    }
  }
  fail(
    'FONT_UNAVAILABLE',
    `None of ${requested.family}, ${FONT_FALLBACKS.join(', ')} could be loaded.`,
    'Install the font in Figma, or pass fontFamily/fontStyle for a font that is available. Use describe on an existing text node to read a family this file already uses.',
  );
}

/* ---------------------------- writers -------------------------------- */

function writeLayout(node: SceneNode, where: string, spec: Record<string, unknown>): void {
  rejectUnknownKeys(where, spec, LAYOUT_KEYS);
  const raw = rawOf(node);

  const mode = spec['mode'];
  if (mode !== undefined) {
    if (mode !== 'NONE' && mode !== 'HORIZONTAL' && mode !== 'VERTICAL' && mode !== 'GRID') {
      fail('BAD_OP', `${where}.mode is "${String(mode)}".`, 'Use NONE, HORIZONTAL, VERTICAL, or GRID.');
    }
    raw['layoutMode'] = mode;
  }

  const padding = spec['padding'];
  if (padding !== undefined) {
    if (typeof padding === 'number') {
      for (const side of PADDING_KEYS) raw[`padding${side[0]?.toUpperCase()}${side.slice(1)}`] = padding;
    } else {
      const sides = readObject(`${where}.padding`, padding);
      rejectUnknownKeys(`${where}.padding`, sides, PADDING_KEYS);
      for (const side of PADDING_KEYS) {
        const value = optionalNumber(`${where}.padding.${side}`, sides[side]);
        if (value !== undefined) raw[`padding${side[0]?.toUpperCase()}${side.slice(1)}`] = value;
      }
    }
  }

  const itemSpacing = optionalNumber(`${where}.itemSpacing`, spec['itemSpacing']);
  if (itemSpacing !== undefined) raw['itemSpacing'] = itemSpacing;
  const counterAxisSpacing = optionalNumber(`${where}.counterAxisSpacing`, spec['counterAxisSpacing']);
  if (counterAxisSpacing !== undefined) raw['counterAxisSpacing'] = counterAxisSpacing;

  for (const [key, property] of [
    ['primaryAxisAlign', 'primaryAxisAlignItems'],
    ['counterAxisAlign', 'counterAxisAlignItems'],
    ['wrap', 'layoutWrap'],
  ] as const) {
    const value = spec[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') fail('BAD_OP', `${where}.${key} must be a string.`);
    raw[property] = value;
  }

  // `sizing`, `grow`, and `align` describe this node inside its parent, so they
  // are applied by the caller once the node has a parent — see applySizing.
}

function writeSizing(node: SceneNode, where: string, layout: Record<string, unknown>): void {
  const raw = rawOf(node);
  const sizing = layout['sizing'];
  if (sizing !== undefined) {
    const spec = readObject(`${where}.sizing`, sizing);
    rejectUnknownKeys(`${where}.sizing`, spec, SIZING_KEYS);
    for (const [key, property] of [
      ['horizontal', 'layoutSizingHorizontal'],
      ['vertical', 'layoutSizingVertical'],
    ] as const) {
      const value = spec[key];
      if (value === undefined) continue;
      if (value !== 'FIXED' && value !== 'HUG' && value !== 'FILL') {
        fail('BAD_OP', `${where}.sizing.${key} is "${String(value)}".`, 'Use FIXED, HUG, or FILL.');
      }
      // FILL inside a non-auto-layout parent is rejected by Figma; report it as
      // the modelling error it is rather than as an opaque API failure.
      if (value === 'FILL') {
        const parent = node.parent;
        const parentMode = parent === null ? 'NONE' : stringAt(rawOf(parent), 'layoutMode') ?? 'NONE';
        if (parentMode === 'NONE') {
          fail(
            'FILL_WITHOUT_AUTO_LAYOUT',
            `${where}.sizing.${key} is FILL, but the parent "${parent === null ? 'page' : nameOf(parent)}" is not an auto-layout frame.`,
            'Set layout.mode on the parent first, or use FIXED with an explicit width/height.',
          );
        }
      }
      raw[property] = value;
    }
  }
  const grow = optionalNumber(`${where}.grow`, layout['grow']);
  if (grow !== undefined) raw['layoutGrow'] = grow;
  const align = layout['align'];
  if (align !== undefined) {
    if (typeof align !== 'string') fail('BAD_OP', `${where}.align must be a string.`);
    raw['layoutAlign'] = align;
  }
}

function writeAppearance(node: SceneNode, where: string, spec: Record<string, unknown>): void {
  const raw = rawOf(node);

  if ('fills' in spec) {
    const paints = toPaints(`${where}.fills`, spec['fills']);
    raw['fills'] = paints ?? [];
  }
  if ('strokes' in spec) {
    const paints = toPaints(`${where}.strokes`, spec['strokes']);
    raw['strokes'] = paints ?? [];
  }
  const strokeWeight = optionalNumber(`${where}.strokeWeight`, spec['strokeWeight']);
  if (strokeWeight !== undefined) raw['strokeWeight'] = strokeWeight;

  const radius = spec['cornerRadius'];
  if (radius !== undefined) {
    if (typeof radius === 'number') {
      raw['cornerRadius'] = radius;
    } else {
      const corners = readObject(`${where}.cornerRadius`, radius);
      rejectUnknownKeys(`${where}.cornerRadius`, corners, RADIUS_KEYS);
      for (const corner of RADIUS_KEYS) {
        const value = optionalNumber(`${where}.cornerRadius.${corner}`, corners[corner]);
        if (value !== undefined) raw[corner] = value;
      }
      // Mixed corners must be set individually; `cornerRadius` stays `mixed`.
    }
  }

  const opacity = optionalNumber(`${where}.opacity`, spec['opacity']);
  if (opacity !== undefined) raw['opacity'] = opacity;
  if (spec['visible'] !== undefined) raw['visible'] = spec['visible'] === true;
  if (spec['clipsContent'] !== undefined && node.type === 'FRAME') {
    raw['clipsContent'] = spec['clipsContent'] === true;
  }
}

const LINE_HEIGHT_UNITS = ['PIXELS', 'PERCENT'] as const;

async function writeText(
  node: SceneNode,
  where: string,
  spec: Record<string, unknown>,
  context: FontContext,
): Promise<void> {
  rejectUnknownKeys(where, spec, TEXT_KEYS);
  if (node.type !== 'TEXT') {
    fail('NOT_TEXT', `${where} targets a ${node.type} node, which has no text properties.`);
  }
  const text = node as TextNode;
  const raw = rawOf(node);

  // Setting `characters` requires the CURRENT font to be loaded; changing
  // `fontName` afterwards requires the NEW one. Getting this backwards is the
  // classic "Cannot write to node with unloaded font" failure.
  const current = raw['fontName'];
  const currentFont: FontName = isPlainObject(current) && typeof current['family'] === 'string'
    ? { family: current['family'] as string, style: typeof current['style'] === 'string' ? current['style'] as string : 'Regular' }
    : { family: 'Inter', style: 'Regular' };
  await loadFontOnce(currentFont, context).catch(() => undefined);

  const characters = spec['characters'];
  if (characters !== undefined) {
    if (typeof characters !== 'string') fail('BAD_OP', `${where}.characters must be a string.`);
    text.characters = characters;
  }

  const family = spec['fontFamily'];
  const style = spec['fontStyle'];
  if (family !== undefined || style !== undefined) {
    if (family !== undefined && typeof family !== 'string') fail('BAD_OP', `${where}.fontFamily must be a string.`);
    if (style !== undefined && typeof style !== 'string') fail('BAD_OP', `${where}.fontStyle must be a string.`);
    const requested: FontName = {
      family: typeof family === 'string' ? family : currentFont.family,
      style: typeof style === 'string' ? style : currentFont.style,
    };
    text.fontName = await resolveFont(requested, context);
  }

  const fontSize = optionalNumber(`${where}.fontSize`, spec['fontSize']);
  if (fontSize !== undefined) text.fontSize = fontSize;

  const lineHeight = spec['lineHeight'];
  if (lineHeight !== undefined) {
    if (lineHeight === 'AUTO') {
      text.lineHeight = { unit: 'AUTO' };
    } else if (typeof lineHeight === 'number') {
      text.lineHeight = { value: lineHeight, unit: 'PIXELS' };
    } else {
      const entry = readObject(`${where}.lineHeight`, lineHeight);
      const unit = entry['unit'];
      if (unit !== 'PIXELS' && unit !== 'PERCENT') {
        fail('BAD_OP', `${where}.lineHeight.unit is "${String(unit)}".`, `Use ${LINE_HEIGHT_UNITS.join(' or ')}, or pass "AUTO".`);
      }
      text.lineHeight = { value: optionalNumber(`${where}.lineHeight.value`, entry['value']) ?? 0, unit };
    }
  }

  const letterSpacing = spec['letterSpacing'];
  if (letterSpacing !== undefined) {
    if (typeof letterSpacing === 'number') {
      text.letterSpacing = { value: letterSpacing, unit: 'PIXELS' };
    } else {
      const entry = readObject(`${where}.letterSpacing`, letterSpacing);
      const unit = entry['unit'];
      if (unit !== 'PIXELS' && unit !== 'PERCENT') {
        fail('BAD_OP', `${where}.letterSpacing.unit is "${String(unit)}".`);
      }
      text.letterSpacing = { value: optionalNumber(`${where}.letterSpacing.value`, entry['value']) ?? 0, unit };
    }
  }

  for (const [key, property] of [
    ['alignHorizontal', 'textAlignHorizontal'],
    ['alignVertical', 'textAlignVertical'],
    ['autoResize', 'textAutoResize'],
  ] as const) {
    const value = spec[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') fail('BAD_OP', `${where}.${key} must be a string.`);
    raw[property] = value;
  }

  const color = spec['color'];
  if (color !== undefined) {
    if (typeof color !== 'string') fail('BAD_OP', `${where}.color must be a hex string.`);
    const parsed = parseColor(`${where}.color`, color);
    const paint: Record<string, unknown> = { type: 'SOLID', color: parsed.color };
    if (parsed.alpha < 1) paint['opacity'] = parsed.alpha;
    text.fills = [paint as unknown as SolidPaint];
  }
}

/* ---------------------------- creation ------------------------------- */

function instantiate(type: CreatableNodeType, where: string): SceneNode {
  switch (type) {
    case 'FRAME':
      return figma.createFrame();
    case 'RECTANGLE':
      return figma.createRectangle();
    case 'ELLIPSE':
      return figma.createEllipse();
    case 'TEXT':
      return figma.createText();
    default:
      fail(
        'UNSUPPORTED_NODE',
        `${where}.type is "${String(type)}".`,
        'Creatable types: FRAME, RECTANGLE, ELLIPSE, TEXT. For anything else, find an existing node with describe and copy it, or ask for a component in a later revision.',
      );
  }
}

async function createFromSpec(
  spec: Record<string, unknown>,
  where: string,
  context: FontContext,
): Promise<SceneNode> {
  rejectUnknownKeys(where, spec, NODE_KEYS);
  const type = spec['type'];
  if (type !== 'FRAME' && type !== 'RECTANGLE' && type !== 'ELLIPSE' && type !== 'TEXT') {
    fail('BAD_OP', `${where}.type is required.`, 'One of FRAME, RECTANGLE, ELLIPSE, TEXT.');
  }
  const node = instantiate(type, where);

  const name = spec['name'];
  if (name !== undefined) node.name = requireString(`${where}.name`, name);

  // Layout mode goes first so children can be appended into it and so padding
  // applies to a container that already has its mode set.
  const layout = spec['layout'];
  const layoutSpec = layout === undefined ? undefined : readObject(`${where}.layout`, layout);
  if (layoutSpec !== undefined) writeLayout(node, `${where}.layout`, layoutSpec);

  const children = spec['children'];
  if (children !== undefined) {
    if (!Array.isArray(children)) fail('BAD_OP', `${where}.children must be an array.`);
    if (node.type !== 'FRAME' && children.length > 0) {
      fail('NOT_A_CONTAINER', `${where} is a ${node.type} with ${children.length} child(ren).`, 'Only FRAME can hold children — use a FRAME, or drop the children.');
    }
    for (const [index, child] of children.entries()) {
      const childSpec = readObject(`${where}.children[${index}]`, child);
      const created = await createFromSpec(childSpec, `${where}.children[${index}]`, context);
      (node as FrameNode).appendChild(created);
      // Sizing and position are only meaningful once a parent exists.
      await finishChild(created, childSpec, `${where}.children[${index}]`);
    }
  }

  writeAppearance(node, where, spec);

  const text = spec['text'];
  if (text !== undefined) {
    await writeText(node, `${where}.text`, readObject(`${where}.text`, text), context);
  }

  applyGeometry(node, where, spec);

  if (layoutSpec !== undefined) writeSizing(node, `${where}.layout`, layoutSpec);

  return node;
}

/** Sizing on a freshly appended child, which is all that must wait for a parent. */
async function finishChild(node: SceneNode, spec: Record<string, unknown>, where: string): Promise<void> {
  const layout = spec['layout'];
  if (layout === undefined) return;
  writeSizing(node, `${where}.layout`, readObject(`${where}.layout`, layout));
}

/**
 * Position and size.
 *
 * A HUG axis owns its own size: Figma rejects a resize on it, or silently
 * reverts one. Quietly dropping the requested value was the worst of the three
 * options, because the caller would go on believing it had resized the node and
 * would read the unchanged width back as its own mistake. The conflict is named
 * instead, with the one-line fix attached.
 */
function applyGeometry(node: SceneNode, where: string, spec: Record<string, unknown>): void {
  const raw = rawOf(node);
  const width = optionalNumber(`${where}.width`, spec['width']);
  const height = optionalNumber(`${where}.height`, spec['height']);

  const axes = [
    { axis: 'horizontal', request: 'width', value: width, property: 'layoutSizingHorizontal' },
    { axis: 'vertical', request: 'height', value: height, property: 'layoutSizingVertical' },
  ] as const;
  for (const entry of axes) {
    if (entry.value === undefined) continue;
    if (stringAt(raw, entry.property) !== 'HUG') continue;
    fail(
      'SIZE_CONFLICT',
      `${where}.${entry.request} is ${entry.value}, but this node's ${entry.axis} sizing is HUG, so it sizes itself from its contents.`,
      `Either drop the explicit ${entry.request}, or add layout.sizing.${entry.axis} = "FIXED" to the same op to take control of that axis.`,
    );
  }

  if (width !== undefined || height !== undefined) {
    const nextWidth = width ?? numberAt(raw, 'width') ?? 100;
    const nextHeight = height ?? numberAt(raw, 'height') ?? 100;
    (node as unknown as { resize: (w: number, h: number) => void }).resize(nextWidth, nextHeight);
  }

  const x = optionalNumber(`${where}.x`, spec['x']);
  const y = optionalNumber(`${where}.y`, spec['y']);
  if (x !== undefined) raw['x'] = x;
  if (y !== undefined) raw['y'] = y;
}

/* ---------------------------- the command ---------------------------- */

interface ApplyContext extends FontContext {
  refs: Map<string, BaseNode>;
  created: ApplyResult['created'];
  updated: string[];
  moved: string[];
  renamed: string[];
  deleted: string[];
  notes: string[];
}

/** Resolve `ref:name` handles, so ops in one batch can refer to each other. */
async function resolveTarget(context: ApplyContext, id: string): Promise<BaseNode> {
  if (id.startsWith('ref:')) {
    const node = context.refs.get(id.slice(4));
    if (node === undefined) {
      fail(
        'UNKNOWN_REF',
        `"${id}" does not match any ref created in this call.`,
        `Refs live only inside one apply call. Defined so far in this call: ${[...context.refs.keys()].join(', ') || '(none)'}. A node made by an earlier call has a real id — read it from that call's result, or find it again with describe — and must be addressed by that id.`,
      );
    }
    if (node.removed) fail('REMOVED_REF', `"${id}" refers to a node that was deleted earlier in this call.`);
    return node;
  }
  const node = await resolveNodePath(id);
  if (node === null) {
    fail(
      'NODE_NOT_FOUND',
      `No node with id "${id}".`,
      `${NODE_ID_HINT} Inside one apply call, prefer the "ref" you gave a create op.`,
    );
  }
  return node;
}

async function applyCommand(args: Record<string, unknown>): Promise<unknown> {
  const ops = args['ops'];
  if (!Array.isArray(ops) || ops.length === 0) {
    fail('BAD_OP', '`ops` must be a non-empty array.', 'Pass one or more operations, e.g. [{ op: "update", id: "1:2", props: { name: "Hero" } }].');
  }

  const context: ApplyContext = {
    refs: new Map(),
    loaded: new Set(),
    substitutions: [],
    created: [],
    updated: [],
    moved: [],
    renamed: [],
    deleted: [],
    notes: [],
  };

  for (const [index, entry] of ops.entries()) {
    const where = `ops[${index}]`;
    const op = readObject(where, entry);
    const kind = op['op'];
    if (typeof kind !== 'string' || OP_KEYS[kind] === undefined) {
      fail(
        'UNKNOWN_OP',
        `${where}.op is ${kind === undefined ? 'missing' : `"${String(kind)}"`}.`,
        `Supported ops: ${Object.keys(OP_KEYS).join(', ')}.`,
      );
    }
    rejectUnknownKeys(where, op, OP_KEYS[kind] as string[]);

    try {
      await runOp(kind, op, where, context);
    } catch (error) {
      const detail = normalizeError(error);
      failWith(
        detail.code,
        `${where} (${kind}) failed: ${detail.message}`,
        detail.hint,
        {
          failedOpIndex: index,
          failedOp: op,
          alreadyApplied: {
            created: context.created,
            updated: context.updated,
            moved: context.moved,
            renamed: context.renamed,
            deleted: context.deleted,
          },
        },
      );
    }
  }

  // One batch, one undo step: without this the user would have to press undo
  // once per node the agent touched.
  figma.commitUndo();

  const result: ApplyResult = {
    created: context.created,
    updated: context.updated,
    moved: context.moved,
    renamed: context.renamed,
    deleted: context.deleted,
    fontsUsed: [...context.loaded].sort(),
    notes: context.notes,
  };
  for (const substitution of context.substitutions) result.notes.push(`Font substituted: ${substitution}.`);
  if (result.created.length > 0) {
    result.notes.push(
      'One undo step covers this whole call. Screenshot the created nodes to check them before reporting success.',
    );
  }
  return result;
}

async function runOp(
  kind: string,
  op: Record<string, unknown>,
  where: string,
  context: ApplyContext,
): Promise<void> {
  if (kind === 'create') {
    const nodeSpec = readObject(`${where}.node`, op['node']);
    const parentId = op['parentId'];
    const parent = parentId === undefined
      ? figma.currentPage
      : await resolveTarget(context, requireString(`${where}.parentId`, parentId));
    if (!('appendChild' in parent)) {
      fail('NOT_A_CONTAINER', `${where}.parentId targets a ${parent.type}, which cannot hold children.`);
    }

    const created = await createFromSpec(nodeSpec, `${where}.node`, context);
    (parent as ChildrenMixin).appendChild(created as SceneNode);
    await finishChild(created, nodeSpec, `${where}.node`);

    const ref = op['ref'];
    if (ref !== undefined) context.refs.set(requireString(`${where}.ref`, ref), created);
    context.created.push({
      ref: typeof ref === 'string' ? ref : null,
      id: created.id,
      name: nameOf(created),
      type: created.type,
    });
    return;
  }

  if (kind === 'update') {
    const target = await resolveTarget(context, requireString(`${where}.id`, op['id']));
    const props = readObject(`${where}.props`, op['props']);
    rejectUnknownKeys(`${where}.props`, props, NODE_KEYS.filter((key) => key !== 'type' && key !== 'children'));
    if (!('removed' in target) || target.removed) fail('REMOVED_REF', `${where}.id refers to a node that no longer exists.`);

    const node = target as SceneNode;
    if (props['name'] !== undefined) node.name = requireString(`${where}.props.name`, props['name']);
    const layout = props['layout'];
    if (layout !== undefined) {
      const layoutSpec = readObject(`${where}.props.layout`, layout);
      writeLayout(node, `${where}.props.layout`, layoutSpec);
      writeSizing(node, `${where}.props.layout`, layoutSpec);
    }
    writeAppearance(node, `${where}.props`, props);
    const text = props['text'];
    if (text !== undefined) {
      await writeText(node, `${where}.props.text`, readObject(`${where}.props.text`, text), context);
    }
    applyGeometry(node, `${where}.props`, props);
    context.updated.push(node.id);
    return;
  }

  if (kind === 'move') {
    const target = await resolveTarget(context, requireString(`${where}.id`, op['id']));
    const node = target as SceneNode;
    const parentId = op['parentId'];
    if (parentId !== undefined) {
      const parent = await resolveTarget(context, requireString(`${where}.parentId`, parentId));
      if (!('appendChild' in parent)) {
        fail('NOT_A_CONTAINER', `${where}.parentId targets a ${parent.type}, which cannot hold children.`);
      }
      const index = optionalNumber(`${where}.index`, op['index']);
      const container = parent as ChildrenMixin & BaseNode;
      if (index === undefined) container.appendChild(node);
      else container.insertChild(Math.max(0, Math.min(index, container.children.length)), node);
    } else {
      const index = optionalNumber(`${where}.index`, op['index']);
      if (index !== undefined) {
        const parent = node.parent;
        if (parent !== null && 'insertChild' in parent) {
          (parent as ChildrenMixin & BaseNode).insertChild(Math.max(0, Math.min(index, (parent as ChildrenMixin).children.length)), node);
        }
      }
    }
    const x = optionalNumber(`${where}.x`, op['x']);
    const y = optionalNumber(`${where}.y`, op['y']);
    if (x !== undefined) rawOf(node)['x'] = x;
    if (y !== undefined) rawOf(node)['y'] = y;
    context.moved.push(node.id);
    return;
  }

  if (kind === 'rename') {
    const target = await resolveTarget(context, requireString(`${where}.id`, op['id']));
    if (target.type === 'DOCUMENT' || target.type === 'PAGE') {
      fail('NOT_RENAMEABLE', `${where}.id targets a ${target.type}.`, 'Only scene nodes can be renamed.');
    }
    (target as SceneNode).name = requireString(`${where}.name`, op['name']);
    context.renamed.push(target.id);
    return;
  }

  // delete
  const target = await resolveTarget(context, requireString(`${where}.id`, op['id']));
  if (target.type === 'DOCUMENT' || target.type === 'PAGE') {
    fail('NOT_DELETABLE', `${where}.id targets a ${target.type}; deleting pages is not supported.`);
  }
  const id = target.id;
  (target as SceneNode).remove();
  context.deleted.push(id);
}

/* -------------------------------------------------------------------------
 * `tokens` — design variables
 *
 * The reason this is worth a tool: a hard-coded `#1d2129` and a token-bound
 * `#1d2129` are indistinguishable in a screenshot and indistinguishable in
 * `describe` unless the binding is reported. `audit` names the difference, and
 * `bind` closes it. Without this, an agent produces a file that looks tidy and
 * falls apart the first time someone changes the theme.
 * ---------------------------------------------------------------------- */

/** Figma stores variable colours as 0–1 channels; this is the reading form. */
function rgbaToHex(value: { r: number; g: number; b: number; a?: number }): string {
  const hex = colorToHex(value);
  const alpha = value.a ?? 1;
  if (alpha >= 1) return hex;
  const byte = Math.round(Math.min(Math.max(alpha, 0), 1) * 255);
  return `${hex}${(byte < 16 ? '0' : '') + byte.toString(16)}`;
}

function isRgbaLike(value: unknown): value is { r: number; g: number; b: number; a?: number } {
  return isRgbLike(value);
}

function isVariableAlias(value: unknown): value is { type: 'VARIABLE_ALIAS'; id: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'VARIABLE_ALIAS' &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/** Render one variable value for a reader, or `null` when it is an alias. */
function renderVariableValue(value: unknown): string | number | boolean | null {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (isRgbaLike(value)) return rgbaToHex(value);
  return null;
}

interface TokenIndex {
  collections: Map<string, VariableCollection>;
  variables: Variable[];
  /** Literal value → variables that already hold it (local, plus library ones in use). */
  byValue: Map<string, TokenVariable[]>;
  /** Library variables this document already uses, discovered by walking it. */
  used: TokenVariable[];
}

function comparisonKey(resolvedType: string, value: unknown): string | null {
  if (resolvedType === 'COLOR' && isRgbaLike(value)) return `COLOR:${rgbaToHex({ ...value, a: 1 })}`;
  if (resolvedType === 'FLOAT' && typeof value === 'number') return `FLOAT:${value}`;
  if (resolvedType === 'STRING' && typeof value === 'string') return `STRING:${value}`;
  if (resolvedType === 'BOOLEAN' && typeof value === 'boolean') return `BOOLEAN:${value}`;
  return null;
}

async function loadTokenIndex(): Promise<TokenIndex> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(collections.map((collection) => [collection.id, collection]));

  // Index the literals so audit can answer "which variable already holds this?".
  const byValue = new Map<string, TokenVariable[]>();
  for (const variable of variables) {
    const collection = byId.get(variable.variableCollectionId);
    const modeId = collection?.defaultModeId ?? Object.keys(variable.valuesByMode)[0];
    if (modeId === undefined) continue;
    const key = comparisonKey(variable.resolvedType, variable.valuesByMode[modeId]);
    if (key === null) continue;
    const summary = summarizeVariable(variable, { collections: byId, variables, byValue, used: [] });
    byValue.set(key, [...(byValue.get(key) ?? []), summary]);
  }
  return { collections: byId, variables, byValue, used: [] };
}

/**
 * Walk the document and index every variable it actually uses.
 *
 * A design system usually lives in a team library, and a library's variables
 * cannot be enumerated from the file — `getLocalVariablesAsync` returns nothing
 * for them and enumerating a library needs the `teamlibrary` permission. They
 * can, however, be *discovered* from the nodes that already bind them, which
 * turns out to be the more useful list anyway: the tokens this file depends on,
 * with the value each one resolves to at a real use site.
 *
 * `resolveForConsumer` is what makes the value trustworthy — it honours aliases
 * and per-mode overrides, so a candidate suggested for a node is the value that
 * node would actually render.
 */
/** A variable seen in use, with the raw value needed to key it by value. */
interface UsedToken {
  token: TokenVariable;
  /**
   * The raw resolved value (`{r,g,b,a}` for a colour), kept separately because
   * `token.value` is the rendered reading form — a hex string, which cannot be
   * value-keyed. Using the rendered form here silently dropped every library
   * colour from the candidate index.
   */
  key: string | null;
}

async function collectUsedTokens(
  index: TokenIndex,
  roots: BaseNode[],
  depth: number,
  limit: number,
): Promise<{ entries: UsedToken[]; scanned: string[]; countLimited: boolean; unreadable: number }> {
  const found = new Map<string, UsedToken>();
  const scanned: string[] = [];
  const cache = new Map<string, Variable | null>();
  let remaining = limit;
  let countLimited = false;
  let unreadable = 0;

  const visit = async (node: BaseNode, levelsLeft: number): Promise<void> => {
    if (remaining <= 0) {
      countLimited = true;
      return;
    }
    remaining -= 1;
    scanned.push(node.id);
    const raw = rawOf(node);

    const bindings: { id: string; field: string }[] = [];
    for (const field of ['fills', 'strokes'] as const) {
      const paints = raw[field];
      if (!Array.isArray(paints)) continue;
      for (const [paintIndex, paint] of paints.entries()) {
        const id = (paint as { boundVariables?: { color?: { id?: unknown } } }).boundVariables?.color?.id;
        if (typeof id === 'string') bindings.push({ id, field: `${field}[${paintIndex}]` });
      }
    }
    const nodeBound = raw['boundVariables'];
    if (nodeBound !== null && typeof nodeBound === 'object') {
      for (const [field, value] of Object.entries(nodeBound as Record<string, unknown>)) {
        const alias = Array.isArray(value) ? value[0] : value;
        const id = alias !== null && typeof alias === 'object' ? (alias as { id?: unknown }).id : undefined;
        if (typeof id === 'string') bindings.push({ id, field });
      }
    }

    for (const binding of bindings) {
      if (found.has(binding.id)) continue;
      let variable = cache.get(binding.id);
      if (variable === undefined) {
        variable = await figma.variables.getVariableByIdAsync(binding.id);
        cache.set(binding.id, variable);
      }
      if (variable === null) {
        // A variable from a library the user cannot access, or one that was deleted.
        unreadable += 1;
        continue;
      }
      let value: unknown;
      try {
        value = variable.resolveForConsumer(node as SceneNode).value;
      } catch {
        const modeId = Object.keys(variable.valuesByMode)[0];
        value = modeId === undefined ? undefined : variable.valuesByMode[modeId];
      }
      const token = summarizeVariable(variable, index);
      token.value = isVariableAlias(value) ? null : renderVariableValue(value);
      token.usedAt = { nodeId: node.id, field: binding.field };
      found.set(binding.id, {
        token,
        key: comparisonKey(variable.resolvedType, value),
      });
    }

    if (levelsLeft <= 0) return;
    const children = raw['children'];
    if (!Array.isArray(children)) return;
    for (const child of children as BaseNode[]) {
      if (remaining <= 0) {
        countLimited = true;
        return;
      }
      await visit(child, levelsLeft - 1);
    }
  };

  for (const root of roots) await visit(root, depth);
  return { entries: [...found.values()], scanned, countLimited, unreadable };
}

/** Fold discovered library variables into the index audit and list read from. */
function attachUsedTokens(index: TokenIndex, entries: UsedToken[]): void {
  const known = new Set(index.variables.map((variable) => variable.id));
  for (const entry of entries) {
    index.used.push(entry.token);
    // A local variable is already indexed by value; a library one is added here,
    // which is the whole point — it can only be found by seeing it used.
    if (known.has(entry.token.id)) continue;
    if (entry.key === null) continue;
    if (index.byValue.get(entry.key)?.some((candidate) => candidate.id === entry.token.id) === true) {
      continue;
    }
    index.byValue.set(entry.key, [...(index.byValue.get(entry.key) ?? []), entry.token]);
  }
}

function summarizeCollection(collection: VariableCollection, index: TokenIndex): TokenCollection {
  return {
    id: collection.id,
    name: collection.name,
    defaultModeId: collection.defaultModeId,
    modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
    variableCount: index.variables.filter((variable) => variable.variableCollectionId === collection.id).length,
  };
}

function summarizeVariable(variable: Variable, index: TokenIndex): TokenVariable {
  const modeId =
    index.collections.get(variable.variableCollectionId)?.defaultModeId ??
    Object.keys(variable.valuesByMode)[0];
  const value = modeId === undefined ? undefined : variable.valuesByMode[modeId];
  const aliases: string[] = [];
  for (const entry of Object.values(variable.valuesByMode)) {
    if (isVariableAlias(entry)) aliases.push(entry.id);
  }
  return {
    id: variable.id,
    name: variable.name,
    collectionId: variable.variableCollectionId,
    collectionName: index.collections.get(variable.variableCollectionId)?.name ?? '(library collection)',
    resolvedType: variable.resolvedType as TokenVariableType,
    value: isVariableAlias(value) ? null : renderVariableValue(value),
    description: typeof variable.description === 'string' ? variable.description : '',
    aliasesTo: [...new Set(aliases)],
    source: variable.remote === true ? 'library' : 'local',
  };
}

/**
 * Fields whose names are worth preferring when several variables hold the same
 * value. Without this, a spacing token suggestion can come back as a radius
 * token that happens to share the number.
 */
const FIELD_NAME_HINTS: Record<string, readonly string[]> = {
  fills: ['bg', 'background', 'surface', 'fill', 'color', 'text'],
  strokes: ['border', 'stroke', 'outline', 'color'],
  itemSpacing: ['space', 'spacing', 'gap'],
  counterAxisSpacing: ['space', 'spacing', 'gap'],
  paddingLeft: ['space', 'spacing', 'padding', 'inset'],
  paddingRight: ['space', 'spacing', 'padding', 'inset'],
  paddingTop: ['space', 'spacing', 'padding', 'inset'],
  paddingBottom: ['space', 'spacing', 'padding', 'inset'],
  cornerRadius: ['radius', 'corner', 'round'],
  strokeWeight: ['border', 'stroke', 'width'],
};

function pickCandidate(field: string, candidates: TokenVariable[]): TokenVariable | undefined {
  const hints = FIELD_NAME_HINTS[field] ?? [];
  const scored = candidates.filter((candidate) => {
    const name = candidate.name.toLowerCase();
    return hints.some((hint) => name.includes(hint));
  });
  // Prefer a local variable over a library one only when names are equally
  // suggestive; otherwise take the best name match, because reusing the token
  // the rest of the file already uses is the point.
  const pool = scored.length > 0 ? scored : candidates;
  return [...pool].sort((left, right) => left.name.localeCompare(right.name))[0];
}

const SCALAR_TOKEN_FIELDS = [
  'itemSpacing',
  'counterAxisSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'cornerRadius',
  'strokeWeight',
  'opacity',
] as const;

/**
 * Whether a scalar value carries design intent.
 *
 * Without this, every node reports `opacity: 1` and `strokeWeight: 1` as
 * "unbound literals that a variable could replace", and the advice to introduce
 * a token for opacity 1 buries the findings that matter. A default is not a
 * decision: report a value only where someone chose it. The strokeWeight rule is
 * the same one the serializer uses — a weight means nothing without a stroke.
 */
function carriesDesignIntent(raw: Record<string, unknown>, field: string, value: number): boolean {
  const layoutMode = stringAt(raw, 'layoutMode') ?? 'NONE';
  switch (field) {
    case 'opacity':
      return value !== 1;
    case 'strokeWeight': {
      const strokes = raw['strokes'];
      const hasStrokes = isMixed(strokes) || (Array.isArray(strokes) && strokes.length > 0);
      return hasStrokes && value !== 0;
    }
    case 'cornerRadius':
      return value !== 0;
    case 'paddingLeft':
    case 'paddingRight':
    case 'paddingTop':
    case 'paddingBottom':
      return value !== 0 && layoutMode !== 'NONE';
    case 'itemSpacing':
      // Zero spacing is a real choice inside auto-layout, but meaningless outside it.
      return layoutMode !== 'NONE';
    case 'counterAxisSpacing':
      // Only means anything on a wrapping container. Elsewhere it is a stored
      // default, and reporting it put `counterAxisSpacing: 0` on every
      // auto-layout frame — which buried the findings that mattered.
      return stringAt(raw, 'layoutWrap') === 'WRAP';
    default:
      return value !== 0;
  }
}

/** Literals on one node that a variable could replace. */
function auditNode(node: BaseNode, index: TokenIndex): TokenAuditFinding[] {
  const raw = rawOf(node);
  const findings: TokenAuditFinding[] = [];
  const name = nameOf(node);
  const bound = isPlainObject(raw['boundVariables']) ? raw['boundVariables'] : {};

  const paintFields = ['fills', 'strokes'] as const;
  for (const field of paintFields) {
    const paints = raw[field];
    if (!Array.isArray(paints)) continue;
    for (const [paintIndex, paint] of paints.entries()) {
      const entry = paint as Record<string, unknown>;
      if (entry['type'] !== 'SOLID' || !isRgbLike(entry['color'])) continue;
      // Already bound? Then there is nothing to fix.
      if (isPlainObject(entry['boundVariables'])) continue;
      const literal = rgbaToHex(entry['color'] as { r: number; g: number; b: number });
      const candidates = index.byValue.get(`COLOR:${literal}`) ?? [];
      const candidate = pickCandidate(field, candidates);
      findings.push({
        nodeId: node.id,
        nodeName: name,
        field: `${field}[${paintIndex}]`,
        literal,
        ...(candidate === undefined
          ? {}
          : {
              candidateVariableId: candidate.id,
              candidateVariableName: candidate.name,
              candidateVariableSource: candidate.source,
            }),
      });
    }
  }

  for (const field of SCALAR_TOKEN_FIELDS) {
    const value = numberAt(raw, field);
    if (value === undefined) continue;
    if (bound[field] !== undefined) continue;
    // Skip defaults: a value nobody chose is not a missing token.
    if (!carriesDesignIntent(raw, field, value)) continue;
    const candidates = index.byValue.get(`FLOAT:${value}`) ?? [];
    const candidate = pickCandidate(field, candidates);
    findings.push({
      nodeId: node.id,
      nodeName: name,
      field,
      literal: String(value),
      ...(candidate === undefined
        ? {}
        : {
            candidateVariableId: candidate.id,
            candidateVariableName: candidate.name,
            candidateVariableSource: candidate.source,
          }),
    });
  }

  return findings;
}

async function listTokens(
  index: TokenIndex,
  filter: Record<string, unknown>,
  walk: { scanned: string[]; countLimited: boolean; unreadable: number },
): Promise<TokensResult> {
  const nameContains = typeof filter['nameContains'] === 'string' ? filter['nameContains'].toLowerCase() : null;
  const typeFilter = typeof filter['type'] === 'string' ? filter['type'] : null;

  const matches = (name: string, type: string): boolean =>
    (typeFilter === null || type === typeFilter) &&
    (nameContains === null || name.toLowerCase().includes(nameContains));

  const local = index.variables
    .map((variable) => summarizeVariable(variable, index))
    .filter((token) => matches(token.name, token.resolvedType));

  // Library variables the document uses, plus any local one that is also in use
  // (a local variable used somewhere is worth marking too).
  const usedLocalIds = new Set(index.used.map((token) => token.id));
  const library = index.used.filter(
    (token) => token.source === 'library' && matches(token.name, token.resolvedType),
  );
  const localWithUse = local.map((token) => {
    const use = index.used.find((entry) => entry.id === token.id);
    return use === undefined ? token : { ...token, usedAt: use.usedAt };
  });

  const variables = [...localWithUse, ...library].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  const usedCollections = new Set(variables.map((variable) => variable.collectionId));
  const collections = [...index.collections.values()]
    .filter((collection) => usedCollections.has(collection.id))
    .map((collection) => summarizeCollection(collection, index));

  const notes: string[] = [];
  if (index.variables.length === 0) {
    notes.push(
      'This file defines no local variables. If its design system lives in a library, the library tokens it uses are listed here with source "library".',
    );
  }
  if (library.length > 0) {
    notes.push(
      `${library.length} library variable(s) are in use here, found by walking the document rather than by enumerating the library — a file cannot list a library it consumes. Bind them by id exactly like a local one.`,
    );
  } else if (index.variables.length > 0) {
    notes.push('No library variables were found in the scanned scope.');
  }
  if (index.used.length === 0 && index.variables.length > 0) {
    notes.push(
      'None of the variables found in scope are bound to anything yet. Use action "audit" to find the literals they could replace.',
    );
  }
  if (walk.unreadable > 0) {
    notes.push(
      `${walk.unreadable} variable binding(s) reference a variable that could not be read — usually one from a library you no longer have access to.`,
    );
  }
  if (walk.countLimited) {
    notes.push(
      `Only the first ${walk.scanned.length} node(s) were walked, so a library token used further down may be missing. Raise \`limit\` or pass \`nodeIds\` to narrow the scope.`,
    );
  }
  if (usedLocalIds.size > 0 || library.length > 0) {
    notes.push(
      'A value is only a token where it is bound. Use action "audit" to find literals that one of these variables could replace.',
    );
  }

  return {
    action: 'list',
    collections,
    deletedVariables: [],
    deletedCollections: [],
    variables,
    bound: [],
    createdVariables: [],
    findings: [],
    scannedNodeIds: walk.scanned,
    notes,
  };
}

async function createTokens(
  request: Record<string, unknown>,
  index: TokenIndex,
): Promise<TokensResult> {
  const specs = request['variables'];
  if (!Array.isArray(specs) || specs.length === 0) {
    fail('BAD_OP', 'tokens "create" needs a non-empty `variables` array.');
  }

  let collection: VariableCollection | undefined;
  if (typeof request['collection'] === 'string') {
    collection = figma.variables.createVariableCollection(request['collection']);
  } else if (typeof request['collectionId'] === 'string') {
    collection = index.collections.get(request['collectionId']);
    if (collection === undefined) {
      fail(
        'COLLECTION_NOT_FOUND',
        `No variable collection with id "${request['collectionId']}".`,
        'Call tokens with action "list" to see the collections in this file.',
      );
    }
  }
  if (collection === undefined) {
    fail(
      'BAD_OP',
      'tokens "create" needs either `collection` (a new name) or `collectionId` (an existing one).',
      'Passing a new name creates the collection; passing an id adds into it.',
    );
  }
  const target = collection;

  const created: TokenVariable[] = [];
  for (const [index_, spec] of specs.entries()) {
    const where = `variables[${index_}]`;
    const entry = readObject(where, spec);
    rejectUnknownKeys(where, entry, ['name', 'type', 'value', 'description']);
    const name = requireString(`${where}.name`, entry['name']);
    const type = entry['type'];
    if (type !== 'COLOR' && type !== 'FLOAT' && type !== 'STRING' && type !== 'BOOLEAN') {
      fail('BAD_OP', `${where}.type is "${String(type)}".`, 'Use COLOR, FLOAT, STRING, or BOOLEAN.');
    }
    const value = entry['value'];
    if (value === undefined) fail('BAD_OP', `${where}.value is required.`);

    let resolved: VariableValue;
    if (type === 'COLOR') {
      const parsed = parseColor(`${where}.value`, requireString(`${where}.value`, value));
      resolved = { r: parsed.color.r, g: parsed.color.g, b: parsed.color.b, a: parsed.alpha };
    } else if (type === 'FLOAT') {
      resolved = optionalNumber(`${where}.value`, value) ?? 0;
    } else if (type === 'STRING') {
      resolved = requireString(`${where}.value`, value);
    } else {
      if (typeof value !== 'boolean') fail('BAD_OP', `${where}.value must be a boolean.`);
      resolved = value;
    }

    const variable = figma.variables.createVariable(name, target, type);
    variable.setValueForMode(target.defaultModeId, resolved);
    const description = entry['description'];
    if (typeof description === 'string') variable.description = description;
    created.push(summarizeVariable(variable, index));
  }

  figma.commitUndo();
  // Re-read the index: summarizing from the pre-create one reported the old
  // variable count, so a caller counting on it saw a number that was off by the
  // variables it had just made.
  const refreshed = await loadTokenIndex();
  const summary = summarizeCollection(refreshed.collections.get(target.id) ?? target, refreshed);
  return {
    action: 'create',
    collections: [summary],
    deletedVariables: [],
    deletedCollections: [],
    variables: [],
    bound: [],
    createdVariables: created,
    createdCollection: summary,
    findings: [],
    scannedNodeIds: [],
    notes: [
      `${created.length} variable(s) created in "${target.name}". Set a value for every mode if the collection has more than one.`,
    ],
  };
}

async function bindTokens(
  request: Record<string, unknown>,
  index: TokenIndex,
): Promise<TokensResult> {
  const requests = request['bindings'];
  if (!Array.isArray(requests) || requests.length === 0) {
    fail('BAD_OP', 'tokens "bind" needs a non-empty `bindings` array.');
  }

  const bound: TokenBindRequest[] = [];
  const notes: string[] = [];

  for (const [position, raw] of requests.entries()) {
    const where = `bindings[${position}]`;
    const binding = readObject(where, raw);
    rejectUnknownKeys(where, binding, ['nodeId', 'field', 'variableId', 'paintIndex']);

    const node = await resolveNodePath(requireString(`${where}.nodeId`, binding['nodeId']));
    if (node === null || node.type === 'DOCUMENT' || node.type === 'PAGE') {
      fail('NODE_NOT_FOUND', `${where}.nodeId does not resolve to a scene node.`);
    }
    const target = node as SceneNode;

    const variableId = requireString(`${where}.variableId`, binding['variableId']);
    const variable = await figma.variables.getVariableByIdAsync(variableId);
    if (variable === null) {
      fail(
        'VARIABLE_NOT_FOUND',
        `No variable with id "${variableId}".`,
        'Call tokens with action "list" to get the ids that exist in this file.',
      );
    }

    const field = requireString(`${where}.field`, binding['field']);
    if (field === 'fills' || field === 'strokes') {
      if (variable.resolvedType !== 'COLOR') {
        fail(
          'TYPE_MISMATCH',
          `${where}.field is "${field}" but the variable is ${variable.resolvedType}.`,
          'Only COLOR variables bind to a paint.',
        );
      }
      const raw_paints = rawOf(target)[field];
      const paints = Array.isArray(raw_paints) ? [...raw_paints] : [];
      const paintIndex = clampInt(binding['paintIndex'], 0, Math.max(0, paints.length - 1), 0);
      const paint = paints[paintIndex];
      if (paint === undefined) {
        fail('PAINT_NOT_FOUND', `${where}: ${field}[${paintIndex}] does not exist on ${nameOf(target)}.`);
      }
      if ((paint as { type?: unknown }).type !== 'SOLID') {
        fail(
          'UNSUPPORTED_PAINT',
          `${where}: ${field}[${paintIndex}] on ${nameOf(target)} is not a SOLID paint.`,
          'Only solid paints can be bound to a colour variable.',
        );
      }
      // Binding returns a copy; the array has to be written back.
      paints[paintIndex] = figma.variables.setBoundVariableForPaint(
        paint as SolidPaint,
        'color',
        variable,
      );
      rawOf(target)[field] = paints;
    } else {
      const bindable = rawOf(target);
      if (!(field in bindable)) {
        fail(
          'UNBINDABLE_FIELD',
          `${where}.field is "${field}", which ${nameOf(target)} does not have.`,
          'Bindable fields include width, height, itemSpacing, paddingLeft/Right/Top/Bottom, cornerRadius, strokeWeight, opacity, and fills/strokes.',
        );
      }
      try {
        (target as unknown as { setBoundVariable: (f: string, v: Variable | null) => void })
          .setBoundVariable(field, variable);
      } catch (error) {
        fail(
          'BIND_FAILED',
          `${where}: could not bind ${field} on ${nameOf(target)} — ${message(error)}`,
          variable.resolvedType === 'COLOR'
            ? 'A COLOR variable binds to fills or strokes, not to a numeric field.'
            : undefined,
        );
      }
    }

    bound.push({
      nodeId: target.id,
      field,
      variableId,
      ...(binding['paintIndex'] === undefined ? {} : { paintIndex: binding['paintIndex'] as number }),
    });
  }

  figma.commitUndo();
  notes.push(
    `${bound.length} binding(s) applied. Binding changes how a value is sourced. It renders identically only when the new variable already holds the same value — rebinding to a variable with a different value does change the canvas, so re-read with describe (or screenshot) to confirm what it now resolves to.`,
  );
  return {
    action: 'bind',
    collections: [],
    deletedVariables: [],
    deletedCollections: [],
    variables: [],
    bound,
    createdVariables: [],
    findings: [],
    scannedNodeIds: [...new Set(bound.map((entry) => entry.nodeId))],
    notes,
  };
}

/** Where a tokens action looks when it was given no explicit ids. */
async function resolveTokenScope(nodeIds: string[]): Promise<BaseNode[]> {
  if (nodeIds.length > 0) {
    const resolved = await resolveByIds(nodeIds);
    if (resolved.nodes.length === 0) {
      fail(
        'NODE_NOT_FOUND',
        `None of the requested node ids exist: ${resolved.missing.join(', ')}.`,
        NODE_ID_HINT,
      );
    }
    return resolved.nodes;
  }
  const selection = [...figma.currentPage.selection];
  return selection.length > 0 ? selection : [...figma.currentPage.children];
}

async function auditTokens(
  request: Record<string, unknown>,
  index: TokenIndex,
  roots: BaseNode[],
  depth: number,
  limit: number,
  walk: { countLimited: boolean; unreadable: number },
): Promise<TokensResult> {
  const findings: TokenAuditFinding[] = [];
  const scanned: string[] = [];
  const budget: DescribeBudget = { remaining: limit, depthLimited: false, countLimited: false };

  const visit = (node: BaseNode, remaining: number): void => {
    if (budget.remaining <= 0) {
      budget.countLimited = true;
      return;
    }
    budget.remaining -= 1;
    scanned.push(node.id);
    findings.push(...auditNode(node, index));
    if (remaining <= 0) {
      budget.depthLimited = true;
      return;
    }
    const children = rawOf(node)['children'];
    if (!Array.isArray(children)) return;
    for (const child of children as BaseNode[]) visit(child, remaining - 1);
  };
  for (const root of roots) visit(root, depth);

  const libraryCandidates = findings.filter((finding) => finding.candidateVariableSource === 'library').length;
  const withCandidate = findings.filter((finding) => finding.candidateVariableId !== undefined).length;
  const notes: string[] = [];
  if (findings.length === 0) {
    notes.push('No unbound literal values were found in scope — everything readable here is either bound or has no matching variable.');
  } else {
    notes.push(
      `${findings.length} unbound literal(s) found; ${withCandidate} already have a variable holding the same value. Bind those with action "bind" — the literal and the token render identically, so nothing visual changes.`,
    );
    if (libraryCandidates > 0) {
      notes.push(
        `${libraryCandidates} of those candidates come from a library rather than this file. Reusing them keeps the file consistent with the rest of the design system; a local variable of the same value would fork it.`,
      );
    }
    if (findings.length > withCandidate) {
      notes.push(
        `${findings.length - withCandidate} literal(s) have no same-valued variable. Use action "create" to introduce tokens for them, or leave them if they are genuinely one-off.`,
      );
    }
  }
  if (index.used.length > 0) {
    notes.push(
      `Candidates were matched against the ${index.used.length} variable(s) this document already uses, so a library token is suggested wherever the file already depends on it.`,
    );
  }
  if (walk.unreadable > 0) {
    notes.push(`${walk.unreadable} binding(s) reference a variable that could not be read, so they could not inform the candidates.`);
  }
  if (budget.countLimited) notes.push(`Only the first ${limit} nodes were scanned; raise \`limit\` to go wider.`);

  return {
    action: 'audit',
    collections: [],
    deletedVariables: [],
    deletedCollections: [],
    variables: [],
    bound: [],
    createdVariables: [],
    findings,
    scannedNodeIds: scanned,
    notes,
  };
}

/**
 * Remove variables, or whole collections.
 *
 * Refuses to remove a variable that something still uses: deleting it would
 * silently orphan every binding, and Figma would then keep the last literal
 * value with no trace of where it came from — the model would see a tidy file
 * and never learn that a token was pulled out from under it.
 */
async function deleteTokens(
  request: Record<string, unknown>,
  index: TokenIndex,
): Promise<TokensResult> {
  const variableIds = readStringArray(request['variableIds']);
  const collectionIds = readStringArray(request['collectionIds']);
  if (variableIds.length === 0 && collectionIds.length === 0) {
    fail(
      'BAD_OP',
      'tokens "delete" needs `variableIds` and/or `collectionIds`.',
      'Call tokens with action "list" to get the ids, or pass a collection id to remove it and everything in it.',
    );
  }

  const inUse = new Set(index.used.map((token) => token.id));
  const deletedVariables: string[] = [];
  for (const id of variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable === null) {
      fail('VARIABLE_NOT_FOUND', `No variable with id "${id}".`, 'Call tokens with action "list" for the ids that exist.');
    }
    if (inUse.has(id)) {
      const use = index.used.find((token) => token.id === id);
      failWith(
        'VARIABLE_IN_USE',
        `"${variable.name}" is still bound to something, so removing it would orphan that binding.`,
        `It is used at ${use?.usedAt?.nodeId ?? 'a node'} on ${use?.usedAt?.field ?? 'a field'}. Bind that node to something else first, or keep this variable.`,
        { variableId: id, usedAt: use?.usedAt },
      );
    }
    variable.remove();
    deletedVariables.push(id);
  }

  const deletedCollections: string[] = [];
  for (const id of collectionIds) {
    const collection = index.collections.get(id);
    if (collection === undefined) {
      fail('COLLECTION_NOT_FOUND', `No local variable collection with id "${id}".`, 'Call tokens with action "list".');
    }
    collection.remove();
    deletedCollections.push(id);
  }

  figma.commitUndo();
  return {
    action: 'delete',
    collections: [],
    variables: [],
    bound: [],
    createdVariables: [],
    findings: [],
    deletedVariables,
    deletedCollections,
    scannedNodeIds: [],
    notes: [
      `${deletedVariables.length} variable(s) and ${deletedCollections.length} collection(s) removed. This is one undo step.`,
    ],
  };
}

async function tokensCommand(args: Record<string, unknown>): Promise<unknown> {
  const action = args['action'];
  if (
    action !== 'list' &&
    action !== 'create' &&
    action !== 'bind' &&
    action !== 'audit' &&
    action !== 'delete'
  ) {
    fail(
      'UNKNOWN_ACTION',
      `tokens action is ${action === undefined ? 'missing' : `"${String(action)}"`}.`,
      'Use "list" to read the file\'s variables, "audit" to find unbound literals, "create" to add variables, "bind" to attach them to nodes, or "delete" to remove them.',
    );
  }

  const index = await loadTokenIndex();

  // Only the reading actions need the document walk, and it is the expensive
  // part: a library token can only be found by looking at what already uses it.
  if (action === 'list' || action === 'audit' || action === 'delete') {
    const nodeIds = readStringArray(args['nodeIds']);
    const depth = clampInt(args['depth'], 0, MAX_DESCRIBE_DEPTH, action === 'list' ? 4 : 2);
    const limit = clampInt(args['limit'], 1, MAX_DESCRIBE_NODES, 200);
    const roots = await resolveTokenScope(nodeIds);
    const found = await collectUsedTokens(index, roots, depth, limit);
    attachUsedTokens(index, found.entries);
    if (action === 'list') return await listTokens(index, args, found);
    if (action === 'audit') return await auditTokens(args, index, roots, depth, limit, found);
    return await deleteTokens(args, index);
  }

  if (action === 'create') return await createTokens(args, index);
  return await bindTokens(args, index);
}

/* -------------------------------------------------------------------------
 * Execution
 * ---------------------------------------------------------------------- */

function normalizeError(error: unknown): CommandError {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; hint?: unknown; details?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : 'PLUGIN_ERROR';
    const message =
      typeof candidate.message === 'string' && candidate.message !== ''
        ? candidate.message
        : 'The plugin threw a value with no message.';
    const out: CommandError = { code, message };
    // `hint` is what turns a refusal into an instruction, so it must survive.
    if (typeof candidate.hint === 'string' && candidate.hint !== '') out.hint = candidate.hint;
    // `details` carries the evidence a partial write leaves behind — which nodes
    // were already created — and losing it would strand the model with a
    // document it cannot reason about.
    if (candidate.details !== undefined) out.details = candidate.details;
    return out;
  }
  return { code: 'PLUGIN_ERROR', message: String(error) };
}

async function execute(command: CommandRequest): Promise<CommandResult> {
  const startedAt = Date.now();
  const handler = handlers[command.name];

  if (handler === undefined) {
    return {
      id: command.id,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `This plugin build cannot run "${command.name}".`,
        hint: `Available here: ${Object.keys(handlers).join(', ')}. The bridge and the plugin are probably different versions — rebuild both.`,
      },
    };
  }

  try {
    const result = await handler(command.args ?? {});
    return { id: command.id, ok: true, result, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      id: command.id,
      ok: false,
      error: normalizeError(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

/* -------------------------------------------------------------------------
 * Transport loop
 * ---------------------------------------------------------------------- */

/**
 * The bridge endpoint.
 *
 * `localhost`, not `127.0.0.1`, because Figma's manifest validator rejects an
 * IPv4 literal in `networkAccess.allowedDomains` ("must be a valid URL") while
 * `http://localhost:<port>` is the form the docs list as valid. The bridge
 * therefore binds both loopback families. Changing the port also requires a
 * matching entry in manifest.json.
 */
function endpoint(): string {
  return `http://localhost:${port}/figma/poll`;
}

/**
 * How the plugin talks about the bridge in the panel.
 *
 * "Bridge" is this codebase's internal name for the process; a plugin user has
 * never heard it, and a panel that says "bridge" does not explain what to start or
 * where. So everything a non-developer can see calls it "the local app" and says
 * what to do about it. Errors only a developer can act on — the log, the protocol
 * version mismatch — keep their facts instead, because there the facts ARE the fix.
 */
const LOCAL_APP = 'the local app';
/**
 * Render an unknown throwable as something a human can act on.
 *
 * Figma's sandbox `fetch` does not reject with an `Error` — it rejects with a
 * plain object — so `String(error)` produced the useless "[object Object]" in
 * the panel and hid the actual cause (connection refused vs. CSP block vs.
 * DNS). Dig for a message, then fall back to JSON, then to the key list.
 */
function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason', 'detail', 'description', 'name']) {
      const value = candidate[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    try {
      const json = JSON.stringify(error);
      if (json !== undefined && json !== '{}') return json;
    } catch {
      // Circular or otherwise unserializable; fall through to the key list.
    }
    const keys = Object.keys(candidate);
    return keys.length > 0
      ? `object with no message (keys: ${keys.join(', ')})`
      : 'empty object thrown by fetch';
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Exponential backoff with jitter, so a restarted bridge is picked up fast. */
function backoffMs(attempt: number): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

async function readErrorBody(response: { text(): Promise<string> }): Promise<string> {
  try {
    const body = await response.text();
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object') {
      const fields = parsed as { message?: unknown; hint?: unknown };
      const parts = [fields.message, fields.hint].filter(
        (part): part is string => typeof part === 'string',
      );
      if (parts.length > 0) return parts.join(' — ');
    }
    return body.slice(0, 300);
  } catch {
    return 'no response body';
  }
}

/**
 * One poll/execute cycle.
 *
 * Kept separate from the loop so the loop can survive a throw. `readIdentity`
 * touches `figma.currentPage`, which Figma disables the moment the plugin starts
 * closing — an unguarded throw there used to kill the loop and leave the panel
 * showing a stale "connected" while nothing was polling at all.
 */
async function iterate(): Promise<void> {
  const request: PollRequest = {
    v: PROTOCOL_VERSION,
    token,
    client: readIdentity(),
    results: outgoingResults,
  };

  let response: PollResponse;
  try {
    const http = await fetch(endpoint(), {
      method: 'POST',
      // text/plain keeps this a CORS "simple request": no preflight, and the
      // bridge has to answer only once.
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(request),
    });

    if (!http.ok) {
      const detail = await readErrorBody(http);
      throw new Error(`${LOCAL_APP} answered HTTP ${http.status}: ${detail}`);
    }

    response = (await http.json()) as PollResponse;
    // The bridge has the results now; anything still buffered was not sent.
    outgoingResults = [];
  } catch (error) {
    failures += 1;
    // The address and the OS-level reason both stay: the first is what the user
    // has to check, the second ("connection refused" vs "blocked") is what tells
    // them whether to start something or to fix a port.
    setLink('offline', `No app found at ${endpoint()} — ${message(error)}`);
    if (failures === 1 || failures % 10 === 0) {
      note(`offline (attempt ${failures}): ${message(error)}`);
    }
    await sleep(backoffMs(failures));
    return;
  }

  if (response.v !== PROTOCOL_VERSION) {
    setLink(
      'error',
      `Version mismatch: ${LOCAL_APP} speaks v${String(response.v)}, this plugin speaks v${PROTOCOL_VERSION}. Update both to the same release.`,
    );
    note('stopped: protocol mismatch');
    running = false;
    return;
  }

    if (failures > 0 || linkState !== 'connected') {
      failures = 0;
      note(`connected on port ${port}`);
      setLink('connected', `Connected to ${endpoint()}`);
    }

    if (typeof response.token === 'string' && response.token !== token) {
      token = response.token;
      try {
        await figma.clientStorage.setAsync(STORAGE_KEY_TOKEN, token);
      } catch {
        // Persisting the pairing token is best-effort.
      }
    }

    for (const command of response.commands) {
      commandCount += 1;
      const outcome = await execute(command);
      outgoingResults.push(outcome);
      note(`${outcome.ok ? 'ok  ' : 'fail'} ${command.name} (${outcome.durationMs} ms)`);
    }

    postState();
}

/**
 * The transport loop.
 *
 * Every cycle is wrapped: a throw anywhere in the iteration logs, shows itself
 * in the panel, and retries, instead of silently ending the loop. A dead loop
 * with a panel still reading "connected" is the worst possible failure here,
 * because the only symptom is a bridge that never receives another poll.
 */
async function loop(): Promise<void> {
  while (running) {
    try {
      await iterate();
    } catch (error) {
      failures += 1;
      setLink('error', `Unexpected error — ${message(error)}`);
      note(`error (attempt ${failures}): ${message(error)}`);
      await sleep(backoffMs(failures));
    }
  }
}

/* -------------------------------------------------------------------------
 * Panel wiring
 * ---------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

figma.showUI(__html__, {
  width: 340,
  height: 380,
  title: 'DSH Figma Bridge',
  themeColors: true,
});

figma.ui.onmessage = async (raw: unknown): Promise<void> => {
  const message = isRecord(raw) ? raw : {};

  if (message['type'] === 'stop') {
    running = false;
    figma.closePlugin();
    return;
  }

  if (message['type'] === 'refresh') {
    postState();
    return;
  }

  if (message['type'] === 'reconfigure') {
    const requested = Number(message['port']);
    if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
      setLink('error', `"${String(message['port'])}" is not a valid port number.`);
      return;
    }
    port = requested;
    token = null;
    failures = 0;
    try {
      await figma.clientStorage.setAsync(STORAGE_KEY_PORT, port);
      await figma.clientStorage.setAsync(STORAGE_KEY_TOKEN, null);
    } catch {
      // Best-effort persistence.
    }
    note(`switched to port ${port}`);
    setLink(
      'connecting',
      `Switching to port ${port}. If a request is in flight this takes effect within ~25 s.`,
    );
  }
};

figma.on('close', () => {
  running = false;
});

figma.on('selectionchange', () => {
  postState();
});

async function main(): Promise<void> {
  try {
    const storedPort = await figma.clientStorage.getAsync(STORAGE_KEY_PORT);
    if (typeof storedPort === 'number' && Number.isInteger(storedPort)) port = storedPort;
    const storedToken = await figma.clientStorage.getAsync(STORAGE_KEY_TOKEN);
    if (typeof storedToken === 'string' && storedToken !== '') token = storedToken;
  } catch {
    // A fresh install simply runs with defaults.
  }

  note(`plugin v${PLUGIN_VERSION} started, looking on port ${port}`);
  setLink(
    'connecting',
    `Looking for ${LOCAL_APP} on ${endpoint()}. If nothing connects, start it with "pnpm serve:standalone".`,
  );
  await loop();
}

void main().catch((error: unknown) => {
  // `void main()` on its own would swallow this, leaving the panel reading a
  // stale "connected" while nothing polls at all — the one failure mode with no
  // visible symptom anywhere.
  const detail = message(error);
  setLink('error', `Stopped after an unexpected error — ${detail}`);
  note(`fatal: ${detail}`);
});
