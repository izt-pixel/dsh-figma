/**
 * Unit tests for `apply` — the write executor.
 *
 * Writes are more dangerous than reads: a wrong description misleads the model,
 * but a wrong write damages a document a human then has to repair. So this
 * exercises the executor against a recording stub of the Figma API and asserts
 * on what actually reached the nodes.
 *
 * The stub is deliberately a *recording* one rather than a mock with
 * expectations: the point is to read back the resulting node state, which is
 * what the user will see on the canvas.
 *
 *   node packages/plugin/scripts/test-apply.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../dist/code.js', import.meta.url)), 'utf8');

let failures = 0;
function check(name, passed, detail) {
  if (passed) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/* -------------------------------------------------------------------------
 * A recording stub of the Figma API.
 * ---------------------------------------------------------------------- */

const MIXED = Symbol('figma.mixed');
const noop = () => {};
const never = () => 0;

let idCounter = 0;
const registry = new Map();
const loads = [];
const commits = [];
/** Fonts the stub pretends are installed. */
let installedFonts = new Set(['Inter Regular', 'Inter Medium', 'Noto Sans SC Regular', 'OPPOSans Regular']);

class FakeNode {
  constructor(type) {
    idCounter += 1;
    this.id = `${type === 'TEXT' ? 9 : 1}:${idCounter}`;
    this.type = type;
    this.name = type.charAt(0) + type.slice(1).toLowerCase();
    this.removed = false;
    this.children = [];
    this.parent = null;
    this.x = 0;
    this.y = 0;
    this.opacity = 1;
    this.visible = true;
    this.strokes = [];
    this.strokeWeight = 1;
    this.width = 100;
    this.height = 100;
    if (type === 'FRAME') {
      this.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
      this.layoutMode = 'NONE';
      this.clipsContent = true;
    } else if (type === 'TEXT') {
      this.characters = '';
      this.fontName = { family: 'Inter', style: 'Regular' };
      this.fontSize = 12;
      this.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
    } else {
      this.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
    }
    registry.set(this.id, this);
  }

  appendChild(child) {
    if (child.parent !== null) child.parent.children = child.parent.children.filter((n) => n !== child);
    child.parent = this;
    this.children.push(child);
  }

  insertChild(index, child) {
    if (child.parent !== null) child.parent.children = child.parent.children.filter((n) => n !== child);
    child.parent = this;
    this.children.splice(index, 0, child);
  }

  resize(width, height) {
    this.resizeCalls = (this.resizeCalls ?? 0) + 1;
    this.width = width;
    this.height = height;
  }

  remove() {
    this.removed = true;
    if (this.parent !== null) this.parent.children = this.parent.children.filter((n) => n !== this);
    registry.delete(this.id);
  }

  setBoundVariable(field, variable) {
    // Figma rejects a colour variable on a numeric field; mirror that so the
    // plugin's BIND_FAILED path is exercised rather than assumed.
    if (variable !== null && variable.resolvedType === 'COLOR') {
      throw new Error(`Cannot bind a COLOR variable to ${field}`);
    }
    this.boundVariables = { ...(this.boundVariables ?? {}) };
    if (variable === null) delete this.boundVariables[field];
    else this.boundVariables[field] = { type: 'VARIABLE_ALIAS', id: variable.id };
  }
}

const page = new FakeNode('PAGE');
page.id = '0:1';
page.name = 'Page 1';
page.selection = [];
registry.clear();
registry.set('0:1', page);

/* Variables: a small seeded theme, plus creation support. */

const collections = [];
const variables = [];
let collectionCounter = 0;
let variableCounter = 0;

class FakeCollection {
  constructor(name) {
    collectionCounter += 1;
    this.id = `VariableCollectionId:${collectionCounter}`;
    this.name = name;
    this.defaultModeId = 'mode:1';
    this.modes = [{ modeId: 'mode:1', name: 'Mode 1' }];
  }
}

class FakeVariable {
  constructor(name, collection, resolvedType, options = {}) {
    variableCounter += 1;
    this.id = `VariableID:${variableCounter}`;
    this.name = name;
    this.variableCollectionId = collection.id;
    this.resolvedType = resolvedType;
    this.valuesByMode = {};
    this.description = '';
    this.remote = options.remote === true;
  }

  setValueForMode(modeId, value) {
    this.valuesByMode[modeId] = value;
  }

  /** Figma resolves aliases and per-mode overrides here; the stub mirrors the shape. */
  resolveForConsumer() {
    const modeId = Object.keys(this.valuesByMode)[0];
    return { value: this.valuesByMode[modeId], resolvedType: this.resolvedType };
  }

  remove() {
    const index = variables.indexOf(this);
    if (index >= 0) variables.splice(index, 1);
  }
}

const themeCollection = new FakeCollection('Theme');
collections.push(themeCollection);
const textPrimary = new FakeVariable('Text/Primary', themeCollection, 'COLOR');
textPrimary.setValueForMode('mode:1', { r: 29 / 255, g: 33 / 255, b: 41 / 255, a: 1 });
variables.push(textPrimary);
const space4 = new FakeVariable('Space/4', themeCollection, 'FLOAT');
space4.setValueForMode('mode:1', 16);
variables.push(space4);

/**
 * A library variable: `remote`, and its collection is deliberately absent from
 * `collections` because `getLocalVariableCollectionsAsync` never returns one.
 * It is only reachable by id, which is exactly the real-world situation.
 */
const libraryVariables = [];
const libraryCollection = new FakeCollection('Shared tokens');
const textSecondary = new FakeVariable('Text/Secondary', libraryCollection, 'COLOR', { remote: true });
textSecondary.setValueForMode('mode:1', { r: 78 / 255, g: 89 / 255, b: 105 / 255, a: 1 });
libraryVariables.push(textSecondary);

/** #4e5969, the value both the bound and the unbound node below use. */
const SECONDARY = { r: 78 / 255, g: 89 / 255, b: 105 / 255 };

const figma = {
  mixed: MIXED,
  apiVersion: '1.0.0',
  editorType: 'figma',
  mode: 'default',
  root: { name: 'Apply Test File', children: [page] },
  currentPage: page,
  showUI: noop,
  on: noop,
  off: noop,
  closePlugin: noop,
  notify: () => ({ cancel: noop }),
  clientStorage: { getAsync: async () => undefined, setAsync: async () => undefined },
  ui: { postMessage: noop, onmessage: null, resize: noop, show: noop, hide: noop },
  getNodeByIdAsync: async (id) => {
    // Mirror Figma: a synthetic instance-scoped id is refused outright, so the
    // only way to reach such a layer is a path from its instance.
    if (id.startsWith('I')) return null;
    const node = registry.get(id);
    return node === undefined || node.removed ? null : node;
  },
  createFrame: () => new FakeNode('FRAME'),
  createRectangle: () => new FakeNode('RECTANGLE'),
  createEllipse: () => new FakeNode('ELLIPSE'),
  createText: () => new FakeNode('TEXT'),
  commitUndo: () => commits.push(Date.now()),
  variables: {
    getLocalVariableCollectionsAsync: async () => collections,
    getLocalVariablesAsync: async () => variables,
    getVariableByIdAsync: async (id) =>
      [...variables, ...libraryVariables].find((variable) => variable.id === id) ?? null,
    createVariableCollection: (name) => {
      const created = new FakeCollection(name);
      collections.push(created);
      return created;
    },
    createVariable: (name, collection, resolvedType) => {
      const created = new FakeVariable(name, collection, resolvedType);
      variables.push(created);
      return created;
    },
    // Binding returns a NEW paint rather than mutating; the caller must write it back.
    setBoundVariableForPaint: (paint, field, variable) => ({
      ...paint,
      boundVariables: { ...(paint.boundVariables ?? {}), [field]: { type: 'VARIABLE_ALIAS', id: variable.id } },
    }),
  },
  loadFontAsync: async (font) => {
    const key = `${font.family} ${font.style}`;
    loads.push(key);
    if (!installedFonts.has(key)) throw new Error(`Cannot load font ${key}`);
  },
};

const sandbox = {
  figma,
  __html__: '<html></html>',
  __uiFiles__: {},
  console: { log: noop, error: noop, warn: noop, info: noop, debug: noop },
  setTimeout: never,
  clearTimeout: noop,
  setInterval: never,
  clearInterval: noop,
  fetch: async () => {
    throw new Error('no bridge in this test');
  },
};

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'code.js' });

check('the bundle exposes its write executor', typeof sandbox.applyCommand === 'function');

/** Run `apply`, returning either the result or the structured error. */
async function apply(ops) {
  try {
    return { ok: true, result: await sandbox.applyCommand({ ops }) };
  } catch (error) {
    return { ok: false, error };
  }
}

function reset() {
  for (const node of [...registry.values()]) {
    if (node.id !== '0:1') registry.delete(node.id);
  }
  page.children = [];
  loads.length = 0;
  commits.length = 0;
  installedFonts = new Set(['Inter Regular', 'Inter Medium', 'Noto Sans SC Regular', 'OPPOSans Regular']);
}

/* -------------------------------------------------------------------------
 * 1. Building a tree in one call
 * ---------------------------------------------------------------------- */

console.log('\n1. one call builds a tree, as one undo step');

reset();
const built = await apply([
  {
    op: 'create',
    ref: 'card',
    node: {
      type: 'FRAME',
      name: 'Login card',
      width: 360,
      height: 240,
      layout: { mode: 'VERTICAL', padding: 24, itemSpacing: 16 },
      fills: [{ type: 'SOLID', color: '#ffffff' }],
      cornerRadius: 16,
      children: [
        { type: 'TEXT', name: 'Title', text: { characters: 'Sign in', fontSize: 20 } },
        { type: 'RECTANGLE', name: 'Button', width: 312, height: 44, fills: [{ type: 'SOLID', color: '#722ed1' }] },
      ],
    },
  },
]);

check('the batch succeeds', built.ok === true, JSON.stringify(built.error));
check('it reports one created node', built.result?.created?.length === 1, JSON.stringify(built.result?.created));
check('the ref is echoed back', built.result?.created?.[0]?.ref === 'card');

const cardNode = registry.get(built.result.created[0].id);
check('children were appended into the frame', cardNode?.children.length === 2, String(cardNode?.children.length));
check('auto-layout mode applied', cardNode?.layoutMode === 'VERTICAL');
check('padding applied on every side', cardNode?.paddingLeft === 24 && cardNode?.paddingRight === 24 && cardNode?.paddingTop === 24 && cardNode?.paddingBottom === 24);
check('itemSpacing applied', cardNode?.itemSpacing === 16);
check('cornerRadius applied', cardNode?.cornerRadius === 16);
check('explicit size applied', cardNode?.width === 360 && cardNode?.height === 240, `${cardNode?.width}x${cardNode?.height}`);
const buttonNode = cardNode.children[1];
check(
  'hex fill converted to Figma channels',
  Math.abs((buttonNode?.fills?.[0]?.color?.r ?? 0) - 114 / 255) < 0.001,
  JSON.stringify(buttonNode?.fills?.[0]?.color),
);
check(
  'a white fill stays white',
  cardNode?.fills?.[0]?.color?.r === 1 && cardNode?.fills?.[0]?.color?.g === 1 && cardNode?.fills?.[0]?.color?.b === 1,
  JSON.stringify(cardNode?.fills?.[0]?.color),
);
check('exactly one undo commit for the whole batch', commits.length === 1, String(commits.length));

const titleNode = cardNode.children[0];
check('the nested text node was created', titleNode?.type === 'TEXT');
check('characters were written', titleNode?.characters === 'Sign in', JSON.stringify(titleNode?.characters));
check('fontSize was written', titleNode?.fontSize === 20);
check('the current font was loaded before writing characters', loads.includes('Inter Regular'), JSON.stringify(loads));

/* -------------------------------------------------------------------------
 * 2. Typos are refused, not ignored
 * ---------------------------------------------------------------------- */

console.log('\n2. unknown properties fail loudly');

reset();
const typo = await apply([{ op: 'create', node: { type: 'FRAME', paddding: 16 } }]);
check('an unknown key is rejected', typo.ok === false && typo.error?.code === 'UNKNOWN_PROPERTY', JSON.stringify(typo.error));
check(
  'the error names the offending key and lists what is accepted',
  typeof typo.error?.message === 'string' &&
    typo.error.message.includes('paddding') &&
    typo.error.hint.includes('Accepted here'),
  typo.error?.message,
);
check('and nothing was created for that op', registry.size === 1, String(registry.size));

const nestedTypo = await apply([
  { op: 'create', node: { type: 'FRAME', layout: { mode: 'VERTICAL', itemSpacng: 8 } } },
]);
check(
  'a nested typo is caught too',
  nestedTypo.ok === false && nestedTypo.error?.code === 'UNKNOWN_PROPERTY' && nestedTypo.error.message.includes('itemSpacng'),
  JSON.stringify(nestedTypo.error),
);

const badOp = await apply([{ op: 'destory', id: '1:2' }]);
check('an unknown op names the supported ones', badOp.ok === false && badOp.error?.code === 'UNKNOWN_OP' && badOp.error.hint.includes('create'), JSON.stringify(badOp.error));

/* -------------------------------------------------------------------------
 * 3. Partial failure hands back what already happened
 * ---------------------------------------------------------------------- */

console.log('\n3. a batch that dies halfway reports its progress');

reset();
const partial = await apply([
  { op: 'create', ref: 'first', node: { type: 'RECTANGLE', name: 'Survives', width: 10, height: 10 } },
  { op: 'update', id: 'ref:first', props: { nope: 1 } },
]);
check('the batch fails', partial.ok === false);
check('the failing op index is reported', partial.error?.details?.failedOpIndex === 1, JSON.stringify(partial.error?.details));
check(
  'the already-created node is listed, because it is on the canvas',
  partial.error?.details?.alreadyApplied?.created?.[0]?.name === 'Survives',
  JSON.stringify(partial.error?.details?.alreadyApplied),
);
check('no undo step is committed for a failed batch', commits.length === 0, String(commits.length));

/* -------------------------------------------------------------------------
 * 4. refs, ids, and the errors that guide the reader
 * ---------------------------------------------------------------------- */

console.log('\n4. refs resolve, and missing targets explain themselves');

reset();
const chained = await apply([
  { op: 'create', ref: 'frame', node: { type: 'FRAME', name: 'Host', width: 200, height: 200, layout: { mode: 'HORIZONTAL' } } },
  { op: 'create', parentId: 'ref:frame', node: { type: 'RECTANGLE', name: 'Child', width: 20, height: 20 } },
  { op: 'update', id: 'ref:frame', props: { name: 'Renamed host' } },
  { op: 'rename', id: 'ref:frame', name: 'Host final' },
]);
check('chained refs work', chained.ok === true, JSON.stringify(chained.error));
const host = page.children[0];
check('the child landed in the referenced parent', host?.children?.[0]?.name === 'Child');
check('update by ref applied', chained.result?.updated?.length === 1);
check('rename by ref applied', host?.name === 'Host final', host?.name);
check('the created child reports the parent as its own node', chained.result?.created?.length === 2);

const badRef = await apply([{ op: 'delete', id: 'ref:nothing' }]);
check('an unknown ref lists the refs that do exist', badRef.ok === false && badRef.error?.code === 'UNKNOWN_REF', JSON.stringify(badRef.error));

const missing = await apply([{ op: 'delete', id: '9:999' }]);
check('an unknown id points back at describe', missing.ok === false && missing.error?.code === 'NODE_NOT_FOUND' && missing.error.hint.includes('describe'), JSON.stringify(missing.error));

/* -------------------------------------------------------------------------
 * 5. Colours
 * ---------------------------------------------------------------------- */

console.log('\n5. colour parsing');

reset();
const colours = await apply([
  { op: 'create', ref: 'a', node: { type: 'RECTANGLE', width: 1, height: 1, fills: [{ type: 'SOLID', color: '#f00' }] } },
  { op: 'create', ref: 'b', node: { type: 'RECTANGLE', width: 1, height: 1, fills: [{ type: 'SOLID', color: '#00000080' }] } },
  { op: 'create', ref: 'c', node: { type: 'RECTANGLE', width: 1, height: 1, fills: null } },
]);
check('shorthand and alpha forms parse', colours.ok === true, JSON.stringify(colours.error));
const red = registry.get(colours.result.created[0].id);
check('#f00 expands to full red', red?.fills?.[0]?.color?.r === 1 && red?.fills?.[0]?.color?.g === 0);
const half = registry.get(colours.result.created[1].id);
check('an alpha channel becomes paint opacity', Math.abs((half?.fills?.[0]?.opacity ?? 1) - 0.502) < 0.01, JSON.stringify(half?.fills?.[0]));
const cleared = registry.get(colours.result.created[2].id);
check('null clears the fills', Array.isArray(cleared?.fills) && cleared.fills.length === 0, JSON.stringify(cleared?.fills));

const badColour = await apply([{ op: 'create', node: { type: 'RECTANGLE', fills: [{ type: 'SOLID', color: 'purple' }] } }]);
check('a non-colour is refused with the accepted forms', badColour.ok === false && badColour.error?.code === 'BAD_COLOR', JSON.stringify(badColour.error));

/* -------------------------------------------------------------------------
 * 6. Sizing that Figma would reject is explained, not attempted
 * ---------------------------------------------------------------------- */

console.log('\n6. FILL without an auto-layout parent is a modelling error');

reset();
const noAutoLayout = await apply([
  { op: 'create', node: { type: 'FRAME', width: 100, height: 100, layout: { sizing: { horizontal: 'FILL' } } } },
]);
check(
  'it is refused with a fix, not an opaque API failure',
  noAutoLayout.ok === false && noAutoLayout.error?.code === 'FILL_WITHOUT_AUTO_LAYOUT' && noAutoLayout.error.hint.includes('layout.mode'),
  JSON.stringify(noAutoLayout.error),
);

reset();
const hugIgnored = await apply([
  {
    op: 'create',
    node: {
      type: 'FRAME',
      width: 500,
      height: 300,
      layout: { mode: 'VERTICAL', sizing: { horizontal: 'HUG' } },
      children: [{ type: 'TEXT', text: { characters: 'x' } }],
    },
  },
]);
check('HUG sizing is applied', hugIgnored.ok === true, JSON.stringify(hugIgnored.error));
const hugFrame = page.children[0];
check('and an explicit width is not forced onto a HUG axis', (hugFrame?.resizeCalls ?? 0) <= 1, String(hugFrame?.resizeCalls));

// Sizing a HUG axis is a conflict, not a no-op: Figma would revert the resize,
// so silently dropping the value would leave the caller believing it resized.
reset();
const hugTarget = new FakeNode('FRAME');
hugTarget.name = 'hugging';
hugTarget.layoutMode = 'VERTICAL';
hugTarget.layoutSizingHorizontal = 'HUG';
page.appendChild(hugTarget);

const hugResize = await apply([{ op: 'update', id: hugTarget.id, props: { width: 228, height: 228 } }]);
check(
  'resizing a HUG axis is refused, not silently dropped',
  hugResize.ok === false && hugResize.error?.code === 'SIZE_CONFLICT',
  JSON.stringify(hugResize.error),
);
check(
  'and the hint names the one-line fix',
  hugResize.error?.hint?.includes('layout.sizing.horizontal') && hugResize.error.hint.includes('FIXED'),
  hugResize.error?.hint,
);
check('the node was not resized', hugTarget.width === 100, String(hugTarget.width));

const hugFixed = await apply([
  {
    op: 'update',
    id: hugTarget.id,
    props: { layout: { sizing: { horizontal: 'FIXED', vertical: 'FIXED' } }, width: 228, height: 228 },
  },
]);
check('switching the axis to FIXED in the same op allows the resize', hugFixed.ok === true, JSON.stringify(hugFixed.error));
check('and the size took effect', hugTarget.width === 228 && hugTarget.height === 228, `${hugTarget.width}x${hugTarget.height}`);

/* -------------------------------------------------------------------------
 * 7. Fonts
 * ---------------------------------------------------------------------- */

console.log('\n7. a missing font is substituted, and the substitution is reported');

reset();
const fallback = await apply([
  { op: 'create', node: { type: 'TEXT', name: 'Label', text: { characters: 'hi', fontFamily: 'NoSuchFont', fontStyle: 'Black' } } },
]);
check('the write still succeeds', fallback.ok === true, JSON.stringify(fallback.error));
const label = page.children[0];
check('a fallback family was used', label?.fontName?.family === 'Inter', JSON.stringify(label?.fontName));
check(
  'the substitution is stated in the result',
  Array.isArray(fallback.result?.notes) &&
    fallback.result.notes.some((note) => note.includes('NoSuchFont') && note.includes('Inter')),
  JSON.stringify(fallback.result?.notes),
);
check('fontsUsed lists what was actually loaded', Array.isArray(fallback.result?.fontsUsed) && fallback.result.fontsUsed.includes('Inter Regular'), JSON.stringify(fallback.result?.fontsUsed));

reset();
const available = await apply([
  { op: 'create', node: { type: 'TEXT', text: { characters: '你好', fontFamily: 'Noto Sans SC', fontStyle: 'Regular' } } },
]);
check('an installed font is used as asked', page.children[0]?.fontName?.family === 'Noto Sans SC', JSON.stringify(page.children[0]?.fontName));

/* -------------------------------------------------------------------------
 * 8. Deletion
 * ---------------------------------------------------------------------- */

console.log('\n8. delete reports what it removed');

reset();
const created = await apply([{ op: 'create', ref: 'doomed', node: { type: 'RECTANGLE', width: 10, height: 10 } }]);
const targetId = created.result.created[0].id;

// By id, not by ref: refs are scoped to the call that created them, which is
// exactly what the UNKNOWN_REF hint now tells a caller who tries otherwise.
const crossCallRef = await apply([{ op: 'delete', id: 'ref:doomed' }]);
check(
  'a ref from an earlier call is refused with an explanation',
  crossCallRef.ok === false &&
    crossCallRef.error?.code === 'UNKNOWN_REF' &&
    crossCallRef.error.hint.includes('only inside one apply call'),
  JSON.stringify(crossCallRef.error),
);

const removed = await apply([{ op: 'delete', id: targetId }]);
check('delete by id succeeds', removed.ok === true, JSON.stringify(removed.error));
check('the id is reported before it disappears', removed.result?.deleted?.[0] === targetId, JSON.stringify(removed.result?.deleted));
check('the node is gone from the document', registry.get(targetId) === undefined);
check('and it was not also counted as updated', removed.result?.updated?.length === 0);

/* -------------------------------------------------------------------------
 * 9. Design variables (`tokens`)
 *
 * The property under test is the one a screenshot cannot show: a literal and a
 * token-bound value render identically, so "is this value bound?" is only
 * answerable by asking.
 * ---------------------------------------------------------------------- */

console.log('\n9. tokens: reading, auditing, and binding variables');

async function tokens(args) {
  try {
    return { ok: true, result: await sandbox.tokensCommand(args) };
  } catch (error) {
    return { ok: false, error };
  }
}

const listed = await tokens({ action: 'list' });
check('list returns the collections', listed.result?.collections?.length === 1, JSON.stringify(listed.error));
check('and the variables', listed.result?.variables?.length === 2, JSON.stringify(listed.result?.variables));
const colourSummary = listed.result.variables.find((variable) => variable.name === 'Text/Primary');
check(
  'a colour variable is rendered as hex, not as three floats',
  colourSummary?.value === '#1d2129',
  JSON.stringify(colourSummary?.value),
);
check('a float variable keeps its number', listed.result.variables.find((v) => v.name === 'Space/4')?.value === 16);
check('the type is reported', colourSummary?.resolvedType === 'COLOR');

const filtered = await tokens({ action: 'list', nameContains: 'space' });
check('list can be filtered by name', filtered.result?.variables?.length === 1 && filtered.result.variables[0].name === 'Space/4');

// A node carrying the same literal the theme already defines.
reset();
const literalNode = new FakeNode('FRAME');
literalNode.name = 'Heading';
literalNode.fills = [{ type: 'SOLID', color: { r: 29 / 255, g: 33 / 255, b: 41 / 255 } }];
literalNode.itemSpacing = 16;
literalNode.layoutMode = 'VERTICAL';
page.appendChild(literalNode);

const audited = await tokens({ action: 'audit', nodeIds: [literalNode.id] });
check('audit finds the unbound fill', audited.result?.findings?.some((f) => f.field === 'fills[0]'), JSON.stringify(audited.result?.findings));
const fillFinding = audited.result.findings.find((f) => f.field === 'fills[0]');
check(
  'and names the variable that already holds that value',
  fillFinding?.candidateVariableName === 'Text/Primary',
  JSON.stringify(fillFinding),
);
check('it reports the literal the way describe would', fillFinding?.literal === '#1d2129', fillFinding?.literal);
const spacingFinding = audited.result.findings.find((f) => f.field === 'itemSpacing');
check(
  'a numeric literal gets a numeric candidate',
  spacingFinding?.candidateVariableName === 'Space/4',
  JSON.stringify(spacingFinding),
);
check(
  'the note says how many already have a candidate',
  Array.isArray(audited.result.notes) && audited.result.notes.some((note) => note.includes('already have a variable')),
  JSON.stringify(audited.result.notes),
);
check(
  'defaults are not reported as missing tokens',
  !audited.result.findings.some((f) => f.field === 'opacity' || f.field === 'strokeWeight'),
  JSON.stringify(audited.result.findings.map((f) => `${f.field}=${f.literal}`)),
);

// A value someone actually chose is reported; a default is not.
// (No reset() here: literalNode must stay resolvable for the bind tests below.)
const deliberate = new FakeNode('FRAME');
deliberate.name = 'Card';
deliberate.opacity = 0.5;
deliberate.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
deliberate.strokeWeight = 2;
page.appendChild(deliberate);
const deliberateAudit = await tokens({ action: 'audit', nodeIds: [deliberate.id] });
check(
  'a deliberate opacity is reported',
  deliberateAudit.result.findings.some((f) => f.field === 'opacity' && f.literal === '0.5'),
  JSON.stringify(deliberateAudit.result.findings),
);
check(
  'a stroke that actually exists reports its weight',
  deliberateAudit.result.findings.some((f) => f.field === 'strokeWeight' && f.literal === '2'),
  JSON.stringify(deliberateAudit.result.findings),
);
check(
  'but a strokeless node does not',
  !audited.result.findings.some((f) => f.field === 'strokeWeight'),
  JSON.stringify(audited.result.findings),
);

const boundFill = await tokens({
  action: 'bind',
  bindings: [{ nodeId: literalNode.id, field: 'fills', variableId: textPrimary.id }],
});
check('binding a fill succeeds', boundFill.ok === true, JSON.stringify(boundFill.error));
check(
  'the paint now carries the variable alias',
  literalNode.fills[0]?.boundVariables?.color?.id === textPrimary.id,
  JSON.stringify(literalNode.fills[0]),
);
check('and the literal colour is still there, so nothing renders differently', literalNode.fills[0].color.r === 29 / 255);

const boundSpacing = await tokens({
  action: 'bind',
  bindings: [{ nodeId: literalNode.id, field: 'itemSpacing', variableId: space4.id }],
});
check('binding a numeric field succeeds', boundSpacing.ok === true, JSON.stringify(boundSpacing.error));
check('the node records the binding', literalNode.boundVariables?.itemSpacing?.id === space4.id, JSON.stringify(literalNode.boundVariables));

const reAudited = await tokens({ action: 'audit', nodeIds: [literalNode.id] });
check(
  'a second audit no longer reports the bound fill',
  !reAudited.result.findings.some((f) => f.field === 'fills[0]'),
  JSON.stringify(reAudited.result.findings),
);
check(
  'nor the bound spacing',
  !reAudited.result.findings.some((f) => f.field === 'itemSpacing'),
  JSON.stringify(reAudited.result.findings),
);

const wrongType = await tokens({
  action: 'bind',
  bindings: [{ nodeId: literalNode.id, field: 'itemSpacing', variableId: textPrimary.id }],
});
check(
  'a colour variable on a numeric field is refused with the reason',
  wrongType.ok === false && wrongType.error?.code === 'BIND_FAILED' && wrongType.error.hint.includes('fills or strokes'),
  JSON.stringify(wrongType.error),
);

const badField = await tokens({
  action: 'bind',
  bindings: [{ nodeId: literalNode.id, field: 'nonsense', variableId: space4.id }],
});
check('an unbindable field is named', badField.ok === false && badField.error?.code === 'UNBINDABLE_FIELD', JSON.stringify(badField.error));

const badVariable = await tokens({
  action: 'bind',
  bindings: [{ nodeId: literalNode.id, field: 'itemSpacing', variableId: 'VariableID:does-not-exist' }],
});
check('an unknown variable points back at list', badVariable.ok === false && badVariable.error?.code === 'VARIABLE_NOT_FOUND' && badVariable.error.hint.includes('list'), JSON.stringify(badVariable.error));

const createdTokens = await tokens({
  action: 'create',
  collection: 'Spacing',
  variables: [
    { name: 'Space/8', type: 'FLOAT', value: 8 },
    { name: 'Surface/Base', type: 'COLOR', value: '#ffffff' },
  ],
});
check('create makes the collection', createdTokens.ok === true, JSON.stringify(createdTokens.error));
check('and the variables', createdTokens.result?.createdVariables?.length === 2);
check('with the colour parsed from hex', createdTokens.result.createdVariables[1].value === '#ffffff', JSON.stringify(createdTokens.result.createdVariables[1]));
check('into the new collection', createdTokens.result.createdCollection?.name === 'Spacing');
check(
  'the reported variable count reflects what was just created, not the pre-create state',
  createdTokens.result.createdCollection?.variableCount === 2,
  JSON.stringify(createdTokens.result.createdCollection),
);

// A projection that drops `children` looks exactly like hitting the depth limit,
// so the depth advice has to mention it or it sends the reader the wrong way.
const projectionParent = new FakeNode('FRAME');
projectionParent.name = 'projection parent';
projectionParent.appendChild(new FakeNode('RECTANGLE'));
page.appendChild(projectionParent);
const projected = await sandbox.describeCommand({
  nodeIds: [projectionParent.id],
  depth: 0,
  fields: ['id', 'name'],
});
check(
  'the depth note mentions the fields projection when one is in play',
  Array.isArray(projected.notes) && projected.notes.some((note) => note.includes('fields')),
  JSON.stringify(projected.notes),
);

const badAction = await tokens({ action: 'purge' });
check(
  'an unknown action names the ones that exist',
  badAction.ok === false && badAction.error?.code === 'UNKNOWN_ACTION' && badAction.error.hint.includes('audit'),
  JSON.stringify(badAction.error),
);

/* -------------------------------------------------------------------------
 * 10. Library variables
 *
 * A design system usually lives in a library, which a file cannot enumerate.
 * It can be discovered from the nodes that already use it — and that is the
 * list that matters, because reusing the token the file already depends on is
 * what keeps it consistent.
 * ---------------------------------------------------------------------- */

console.log('\n10. library variables are discovered from use, and suggested as candidates');

reset();
const boundToLibrary = new FakeNode('TEXT');
boundToLibrary.name = 'Caption (already using the library token)';
boundToLibrary.fills = [
  { type: 'SOLID', color: SECONDARY, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: textSecondary.id } } },
];
page.appendChild(boundToLibrary);

const unboundSameColour = new FakeNode('TEXT');
unboundSameColour.name = 'Caption (hard-coded)';
unboundSameColour.fills = [{ type: 'SOLID', color: SECONDARY }];
page.appendChild(unboundSameColour);

const scope = [boundToLibrary.id, unboundSameColour.id];

const listed2 = await tokens({ action: 'list', nodeIds: scope, depth: 0 });
const libraryToken = listed2.result.variables.find((variable) => variable.name === 'Text/Secondary');
check('a library variable shows up in list', libraryToken !== undefined, JSON.stringify(listed2.result.variables.map((v) => `${v.name}:${v.source}`)));
check('marked as coming from a library', libraryToken?.source === 'library', libraryToken?.source);
check(
  'with the value it resolves to at the node that uses it',
  libraryToken?.value === '#4e5969',
  JSON.stringify(libraryToken?.value),
);
check(
  'and the node that uses it, so the model can point at a working example',
  libraryToken?.usedAt?.nodeId === boundToLibrary.id && libraryToken.usedAt.field === 'fills[0]',
  JSON.stringify(libraryToken?.usedAt),
);
check(
  'the local variables are still listed alongside it',
  listed2.result.variables.some((variable) => variable.name === 'Text/Primary' && variable.source === 'local'),
);
check(
  'the note explains where the library tokens came from',
  listed2.result.notes.some((note) => note.includes('library variable')),
  JSON.stringify(listed2.result.notes),
);

const audited2 = await tokens({ action: 'audit', nodeIds: scope, depth: 0, limit: 20 });
const hardCoded = audited2.result.findings.find((finding) => finding.nodeId === unboundSameColour.id);
check('the hard-coded colour is reported', hardCoded !== undefined, JSON.stringify(audited2.result.findings));
check(
  'and a library variable is suggested as its candidate',
  hardCoded?.candidateVariableName === 'Text/Secondary',
  JSON.stringify(hardCoded),
);
check(
  'the candidate is marked as library, so the model knows it is not local',
  hardCoded?.candidateVariableSource === 'library',
  JSON.stringify(hardCoded?.candidateVariableSource),
);
check(
  'the already-bound node is not reported',
  !audited2.result.findings.some((finding) => finding.nodeId === boundToLibrary.id && finding.field === 'fills[0]'),
  JSON.stringify(audited2.result.findings.map((f) => `${f.nodeId}/${f.field}`)),
);
check(
  'the note points out that reusing a library token avoids forking the system',
  audited2.result.notes.some((note) => note.includes('library') && note.includes('fork')),
  JSON.stringify(audited2.result.notes),
);

const boundLibrary = await tokens({
  action: 'bind',
  bindings: [{ nodeId: unboundSameColour.id, field: 'fills', variableId: textSecondary.id }],
});
check('a library variable can be bound by id', boundLibrary.ok === true, JSON.stringify(boundLibrary.error));
check(
  'and the paint now carries the library alias',
  unboundSameColour.fills[0]?.boundVariables?.color?.id === textSecondary.id,
  JSON.stringify(unboundSameColour.fills[0]),
);

const reAudited2 = await tokens({ action: 'audit', nodeIds: scope, depth: 0, limit: 20 });
check(
  'auditing again reports nothing for either node',
  !reAudited2.result.findings.some((finding) => finding.field === 'fills[0]'),
  JSON.stringify(reAudited2.result.findings.map((f) => `${f.nodeId}/${f.field}`)),
);

console.log('\n11. counter-axis spacing is only a decision on a wrapping container');

const nonWrapping = new FakeNode('FRAME');
nonWrapping.name = 'non-wrapping';
nonWrapping.layoutMode = 'VERTICAL';
nonWrapping.layoutWrap = 'NO_WRAP';
nonWrapping.counterAxisSpacing = 0;
nonWrapping.itemSpacing = 24;
page.appendChild(nonWrapping);

const wrapping = new FakeNode('FRAME');
wrapping.name = 'wrapping';
wrapping.layoutMode = 'HORIZONTAL';
wrapping.layoutWrap = 'WRAP';
wrapping.counterAxisSpacing = 16;
page.appendChild(wrapping);

const spacingAudit = await tokens({ action: 'audit', nodeIds: [nonWrapping.id, wrapping.id], depth: 0, limit: 20 });
const spacingFields = spacingAudit.result.findings.map((finding) => `${finding.nodeId}/${finding.field}`);
check(
  'counterAxisSpacing is not reported on a non-wrapping frame',
  !spacingFields.includes(`${nonWrapping.id}/counterAxisSpacing`),
  JSON.stringify(spacingFields),
);
check(
  'but it is reported when the container wraps',
  spacingFields.includes(`${wrapping.id}/counterAxisSpacing`),
  JSON.stringify(spacingFields),
);
check(
  'itemSpacing is still reported either way',
  spacingFields.includes(`${nonWrapping.id}/itemSpacing`),
  JSON.stringify(spacingFields),
);

// An id from inside an instance cannot be resolved by id at all, so the error
// must not blame a recreated node.
const instanceScoped = await tokens({ action: 'audit', nodeIds: ['I885:1923;76:646;80:825;78:672'], depth: 0 });
check(
  'an instance-scoped id fails with the real reason',
  instanceScoped.ok === false && instanceScoped.error?.hint?.includes('inside an instance'),
  JSON.stringify(instanceScoped.error),
);

/* -------------------------------------------------------------------------
 * 12. Addressing layers inside an instance, and removing variables
 * ---------------------------------------------------------------------- */

console.log('\n12. id paths reach what a synthetic id cannot');

/** Give a node a synthetic instance-scoped id, as Figma does internally. */
function adoptId(node, id) {
  registry.delete(node.id);
  node.id = id;
  registry.set(id, node);
  return node;
}

const instance = new FakeNode('FRAME');
instance.name = 'nav bar instance';
const navInner = adoptId(new FakeNode('FRAME'), 'I1:900;76:646');
navInner.name = 'top nav';
const navLeaf = adoptId(new FakeNode('TEXT'), 'I1:900;76:646;80:825');
navLeaf.name = '网页名称';
navInner.appendChild(navLeaf);
instance.appendChild(navInner);
page.appendChild(instance);

check(
  'the synthetic id really is unresolvable by itself',
  (await figma.getNodeByIdAsync(navLeaf.id)) === null,
);

const viaOneHop = await apply([{ op: 'rename', id: `${instance.id}/76:646`, name: 'renamed inner' }]);
check('a one-hop path resolves', viaOneHop.ok === true, JSON.stringify(viaOneHop.error));
check('and names the right node', navInner.name === 'renamed inner', navInner.name);

const viaTwoHops = await apply([{ op: 'rename', id: `${instance.id}/76:646/80:825`, name: 'renamed leaf' }]);
check('a two-hop path resolves', viaTwoHops.ok === true, JSON.stringify(viaTwoHops.error));
check('and reaches the innermost layer', navLeaf.name === 'renamed leaf', navLeaf.name);

const viaBinding = await tokens({
  action: 'bind',
  bindings: [{ nodeId: `${instance.id}/76:646/80:825`, field: 'fills', variableId: textPrimary.id }],
});
check('tokens bind accepts a path too', viaBinding.ok === true, JSON.stringify(viaBinding.error));
check('and binds the addressed layer', navLeaf.fills[0]?.boundVariables?.color?.id === textPrimary.id);

const badPath = await apply([{ op: 'rename', id: `${instance.id}/99:999`, name: 'nope' }]);
check('a path that matches nothing fails', badPath.ok === false && badPath.error?.code === 'NODE_NOT_FOUND', JSON.stringify(badPath.error));

// Two siblings whose synthetic ids share a tail must not be guessed between:
// picking the wrong layer inside an instance is a silent mis-edit.
const ambiguousParent = new FakeNode('FRAME');
ambiguousParent.name = 'ambiguous parent';
const ambiguousA = adoptId(new FakeNode('TEXT'), 'I1:901;11:22');
const ambiguousB = adoptId(new FakeNode('TEXT'), 'I1:901;33:22');
ambiguousParent.appendChild(ambiguousA);
ambiguousParent.appendChild(ambiguousB);
page.appendChild(ambiguousParent);

const guessed = await apply([{ op: 'rename', id: `${ambiguousParent.id}/22`, name: 'should not happen' }]);
check(
  'an ambiguous path is refused rather than guessed',
  guessed.ok === false && guessed.error?.code === 'NODE_NOT_FOUND',
  JSON.stringify(guessed.error),
);
check('and neither sibling was touched', ambiguousA.name !== 'should not happen' && ambiguousB.name !== 'should not happen');
check(
  'and the hint explains the path form rather than blaming a recreated node',
  badPath.error?.hint?.includes('path of ids from the instance'),
  badPath.error?.hint,
);
check(
  'a describe failure uses the same explanation',
  (await tokens({ action: 'audit', nodeIds: [navLeaf.id], depth: 0 })).error?.hint?.includes('path of ids'),
);

console.log('\n13. deleting variables');

const doomedVariable = new FakeVariable('Unused/Doomed', themeCollection, 'COLOR');
doomedVariable.setValueForMode('mode:1', { r: 1, g: 0, b: 0, a: 1 });
variables.push(doomedVariable);

const removedVariable = await tokens({ action: 'delete', variableIds: [doomedVariable.id] });
check('an unused variable can be removed', removedVariable.ok === true, JSON.stringify(removedVariable.error));
check('and is reported by id', removedVariable.result?.deletedVariables?.[0] === doomedVariable.id);
check('it is gone', variables.every((variable) => variable.id !== doomedVariable.id));

const inUse = await tokens({ action: 'delete', variableIds: [textPrimary.id] });
check(
  'a variable still bound somewhere is refused',
  inUse.ok === false && inUse.error?.code === 'VARIABLE_IN_USE',
  JSON.stringify(inUse.error),
);
check(
  'and the refusal says where it is used',
  inUse.error?.hint?.includes('fills') && inUse.error?.details?.usedAt !== undefined,
  JSON.stringify(inUse.error),
);

const noTargets = await tokens({ action: 'delete' });
check('delete with no targets explains what it needs', noTargets.ok === false && noTargets.error?.code === 'BAD_OP', JSON.stringify(noTargets.error));

const badAction2 = await tokens({ action: 'purge' });
check(
  'the unknown-action hint now lists delete',
  badAction2.ok === false && badAction2.error?.hint.includes('delete'),
  badAction2.error?.hint,
);

console.log(
  failures === 0
    ? '\nAll apply checks passed.\n'
    : `\n${failures} apply check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);