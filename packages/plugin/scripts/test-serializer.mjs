/**
 * Unit tests for the plugin's serializer — the code that decides what the model
 * is told about the canvas.
 *
 * This exists because that code is otherwise untestable: the bundle must be a
 * classic script with no exports, so nothing inside it can be imported. It can,
 * however, be *evaluated*: a top-level `function` declaration in a classic
 * script becomes a property of the global object, so running the bundle in a vm
 * context with a stubbed `figma` exposes `serializeNode`, `describeCommand`, and
 * friends for direct calls.
 *
 * A lying serializer is worse than a missing feature: the model edits what it
 * was told, so a property reported as absent when it actually exists leads to
 * silent data loss on the next write.
 *
 *   node packages/plugin/scripts/test-serializer.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const bundlePath = fileURLToPath(new URL('../dist/code.js', import.meta.url));
const source = readFileSync(bundlePath, 'utf8');

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
 * A stubbed Figma, just enough for the module to load.
 * ---------------------------------------------------------------------- */

const MIXED = Symbol('figma.mixed');
const noop = () => {};
const never = () => 0;

const page = { id: '0:1', name: 'Page 1', selection: [], children: [] };
const nodes = new Map();

const figma = {
  mixed: MIXED,
  apiVersion: '1.0.0',
  editorType: 'figma',
  mode: 'default',
  root: { name: 'Serializer Test File', children: [page] },
  currentPage: page,
  showUI: noop,
  on: noop,
  off: noop,
  closePlugin: noop,
  notify: () => ({ cancel: noop }),
  clientStorage: { getAsync: async () => undefined, setAsync: async () => undefined },
  ui: { postMessage: noop, onmessage: null, resize: noop, show: noop, hide: noop },
  getNodeByIdAsync: async (id) => nodes.get(id) ?? null,
};

const sandbox = {
  figma,
  // Injected by Figma because the manifest declares a `ui` file.
  __html__: '<html></html>',
  __uiFiles__: {},
  console: { log: noop, error: noop, warn: noop, info: noop, debug: noop },
  // Deliberately never fire: the transport loop's `await sleep(...)` then parks
  // forever, so the module settles instead of spinning in the background.
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

check('the bundle evaluates and exposes its serializer', typeof sandbox.serializeNode === 'function');

/* -------------------------------------------------------------------------
 * Helpers for building fake nodes: the serializer reads everything through
 * plain property access, so a plain object is a faithful stand-in.
 * ---------------------------------------------------------------------- */

function fakeNode(properties) {
  const node = { removed: false, ...properties };
  nodes.set(node.id, node);
  return node;
}

function freshBudget(remaining = 100) {
  return { remaining, depthLimited: false, countLimited: false };
}

function serialize(node, depth = 3) {
  const budget = freshBudget();
  return { out: sandbox.serializeNode(node, depth, budget), budget };
}

/* -------------------------------------------------------------------------
 * 1. `figma.mixed` must be reported, never dropped
 * ---------------------------------------------------------------------- */

console.log('\n1. mixed values are reported as "mixed", not omitted');

const mixedText = serialize(
  fakeNode({
    id: '1:1',
    name: 'agreement',
    type: 'TEXT',
    characters: 'login implies agreement',
    fontSize: MIXED,
    fontName: MIXED,
    lineHeight: MIXED,
    letterSpacing: MIXED,
    textAlignHorizontal: MIXED,
    fills: MIXED,
    opacity: MIXED,
    visible: MIXED,
  }),
);

check('text.fontSize is reported', mixedText.out.text?.fontSize === 'mixed', JSON.stringify(mixedText.out.text));
check('text.fontName is reported', mixedText.out.text?.fontName === 'mixed');
check('text.lineHeight is reported', mixedText.out.text?.lineHeight === 'mixed');
check('text.letterSpacing is reported', mixedText.out.text?.letterSpacing === 'mixed');
check('text.alignHorizontal is reported', mixedText.out.text?.alignHorizontal === 'mixed');
check(
  'fills is reported — a node with bound, varying fills must not look fill-less',
  mixedText.out.fills === 'mixed',
  JSON.stringify(mixedText.out.fills),
);
check('opacity is reported', mixedText.out.opacity === 'mixed');
check('visible is reported', mixedText.out.visible === 'mixed');

const mixedFrame = serialize(
  fakeNode({
    id: '1:2',
    name: 'card',
    type: 'FRAME',
    width: 100,
    height: 100,
    cornerRadius: MIXED,
    strokeWeight: MIXED,
    strokes: MIXED,
  }),
);
check('cornerRadius is reported', mixedFrame.out.cornerRadius === 'mixed');
check(
  'strokeWeight is reported — the node has a stroke, so silence would be a lie',
  mixedFrame.out.strokeWeight === 'mixed',
  JSON.stringify(mixedFrame.out),
);
check('strokes is reported', mixedFrame.out.strokes === 'mixed');

/* -------------------------------------------------------------------------
 * 2. Concrete values still serialize exactly as before
 * ---------------------------------------------------------------------- */

console.log('\n2. concrete values are unaffected');

const solid = serialize(
  fakeNode({
    id: '1:3',
    name: 'panel',
    type: 'FRAME',
    x: 10,
    y: 20.456,
    width: 346,
    height: 520,
    cornerRadius: 16,
    strokeWeight: 1,
    layoutMode: 'HORIZONTAL',
    itemSpacing: 10,
    paddingTop: 12,
    paddingLeft: 12,
    layoutSizingHorizontal: 'FILL',
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    strokes: [{ type: 'SOLID', color: { r: 0.898, g: 0.902, b: 0.922 } }],
    boundVariables: { fills: { id: 'VariableID:85:843' } },
  }),
);

check('coordinates are rounded, not dropped', solid.out.y === 20.46, String(solid.out.y));
check('cornerRadius keeps its value', solid.out.cornerRadius === 16);
check('strokeWeight keeps its value', solid.out.strokeWeight === 1);
check('fills become hex', solid.out.fills?.[0]?.color === '#ffffff', JSON.stringify(solid.out.fills));
check(
  'variable bindings survive',
  solid.out.variables?.fills === 'VariableID:85:843',
  JSON.stringify(solid.out.variables),
);
check('auto-layout is reported in Figma terms', solid.out.layout?.mode === 'HORIZONTAL');
check(
  'zero padding is omitted rather than listed',
  solid.out.layout?.padding !== undefined &&
    solid.out.layout.padding.top === 12 &&
    solid.out.layout.padding.bottom === undefined,
  JSON.stringify(solid.out.layout?.padding),
);

/* -------------------------------------------------------------------------
 * 3. Truncation says which limit was hit
 * ---------------------------------------------------------------------- */

console.log('\n3. truncation distinguishes depth from node budget');

const parent = fakeNode({
  id: '1:4',
  name: 'parent',
  type: 'FRAME',
  children: [
    fakeNode({ id: '1:5', name: 'a', type: 'FRAME' }),
    fakeNode({ id: '1:6', name: 'b', type: 'FRAME' }),
  ],
});

const depthCut = serialize(parent, 0);
check('depth 0 omits children', depthCut.out.childrenOmitted === 2, JSON.stringify(depthCut.out));
check('and flags the depth limit', depthCut.budget.depthLimited === true);
check('without claiming the node budget ran out', depthCut.budget.countLimited === false);

const countCutBudget = freshBudget(2);
sandbox.serializeNode(parent, 5, countCutBudget);
check('a small budget flags the count limit', countCutBudget.countLimited === true, JSON.stringify(countCutBudget));
check('and does not blame depth', countCutBudget.depthLimited === false);

const roomy = serialize(parent, 5);
check('with room, no limit is flagged', roomy.budget.depthLimited === false && roomy.budget.countLimited === false);
check('and children are serialized', Array.isArray(roomy.out.children) && roomy.out.children.length === 2);

/* -------------------------------------------------------------------------
 * 3b. A stroke's weight must be unambiguous
 *
 * Found in the Accfox file: a node reported a `strokes` array but no
 * `strokeWeight`, which reads as Figma's default weight of 1. Reporting the
 * array while dropping a zero weight implies a stroke that is not drawn.
 * ---------------------------------------------------------------------- */

console.log('\n3b. strokeWeight is reported whenever a stroke exists');

const darkStroke = [{ type: 'SOLID', color: { r: 0.11, g: 0.13, b: 0.16 } }];

const zeroWeight = serialize(
  fakeNode({ id: '1:10', name: 'qr', type: 'FRAME', width: 10, height: 10, strokes: darkStroke, strokeWeight: 0 }),
);
check(
  'a zero weight on a stroked node is stated, not dropped',
  zeroWeight.out.strokeWeight === 0,
  JSON.stringify(zeroWeight.out),
);
check('and the strokes are still listed', Array.isArray(zeroWeight.out.strokes));

const normalWeight = serialize(
  fakeNode({ id: '1:11', name: 'card', type: 'FRAME', width: 10, height: 10, strokes: darkStroke, strokeWeight: 1.264706015586853 }),
);
check('a fractional weight survives intact', normalWeight.out.strokeWeight === 1.264706015586853);

const noStrokes = serialize(
  fakeNode({ id: '1:12', name: 'plain', type: 'FRAME', width: 10, height: 10, strokes: [], strokeWeight: 1 }),
);
check(
  'a node with no strokes carries no weight noise',
  noStrokes.out.strokeWeight === undefined && noStrokes.out.strokes === undefined,
  JSON.stringify(noStrokes.out),
);

/* -------------------------------------------------------------------------
 * 4. `describe` reports the flags at the top level, with actionable notes
 * ---------------------------------------------------------------------- */

console.log('\n4. describe reports which limit was hit');

const depthResult = await sandbox.describeCommand({ nodeIds: ['1:4'], depth: 0, limit: 50 });
check('depthLimited is set on the result', depthResult.depthLimited === true, JSON.stringify(depthResult.depthLimited));
check('countLimited is not', depthResult.countLimited === false);
check('truncated stays as the summary flag', depthResult.truncated === true);
check(
  'the note tells the reader to raise depth',
  Array.isArray(depthResult.notes) && depthResult.notes.some((note) => note.includes('depth')),
  JSON.stringify(depthResult.notes),
);

const countResult = await sandbox.describeCommand({ nodeIds: ['1:4'], depth: 5, limit: 1 });
check('countLimited is set when the budget runs out', countResult.countLimited === true, JSON.stringify(countResult.countLimited));
check('depthLimited is not', countResult.depthLimited === false);
check(
  'the note points at the node budget instead',
  Array.isArray(countResult.notes) && countResult.notes.some((note) => note.includes('node budget')),
  JSON.stringify(countResult.notes),
);

/* -------------------------------------------------------------------------
 * 5. The specific real-world regression
 *
 * In the Accfox file, the agreement text node reported `variables.fills` (a
 * bound variable) while `fills` was absent, because the two lines have
 * different colours. The model would see a fill bound to a token and no fill at
 * the same time.
 * ---------------------------------------------------------------------- */

console.log('\n5. regression: bound-but-mixed fills');

const boundMixed = serialize(
  fakeNode({
    id: '1:7',
    name: 'text',
    type: 'TEXT',
    characters: 'line one\nline two',
    fontSize: 12,
    fills: MIXED,
    boundVariables: { fills: { id: 'VariableID:17bfc0ab' }, textRangeFills: { id: 'VariableID:17bfc0ab' } },
  }),
);
check(
  'a node can report both a fill binding and mixed fills',
  boundMixed.out.variables?.fills === 'VariableID:17bfc0ab' && boundMixed.out.fills === 'mixed',
  JSON.stringify({ fills: boundMixed.out.fills, variables: boundMixed.out.variables }),
);
check('concrete text properties still come through', boundMixed.out.text?.fontSize === 12);

/* -------------------------------------------------------------------------
 * 6. Ids a write tool cannot accept must say so where they are handed out
 * ---------------------------------------------------------------------- */

console.log('\n6. instance-scoped ids are flagged');

const instanceChild = serialize(
  fakeNode({ id: 'I885:1923;76:646;80:825;78:672', name: '网页名称', type: 'TEXT', characters: 'x' }),
);
check(
  'a layer inside an instance is marked',
  instanceChild.out.instanceScoped === true,
  JSON.stringify(instanceChild.out),
);

// The address has to be usable: an id's segments are component node ids, not
// tree levels, so a reader cannot derive the path from the id it was given.
const realFrame = fakeNode({ id: '885:1923', name: 'nav instance', type: 'INSTANCE', parent: null });
const level1 = fakeNode({ id: 'I885:1923;18:3171', name: 'level 1', type: 'FRAME', parent: realFrame });
const level2 = fakeNode({ id: 'I885:1923;89:1724', name: 'level 2', type: 'FRAME', parent: level1 });
const nested = fakeNode({ id: 'I885:1923;80:825', name: 'nested instance', type: 'INSTANCE', parent: level2 });
const leaf = fakeNode({ id: 'I885:1923;80:825;78:673', name: 'leaf', type: 'FRAME', parent: nested });

const leafSerialized = serialize(leaf);
check(
  'the address path lists every tree level, not the id segments',
  leafSerialized.out.addressPath === '885:1923/18:3171/89:1724/80:825/78:673',
  JSON.stringify(leafSerialized.out.addressPath),
);
check(
  'and stops at the first normally addressable ancestor',
  leafSerialized.out.addressPath.startsWith('885:1923/'),
  leafSerialized.out.addressPath,
);
check(
  'a node with no addressable ancestor gets no false path',
  serialize(fakeNode({ id: 'I900:1;2:2', name: 'orphan', type: 'FRAME', parent: null })).out.addressPath === undefined,
  'expected no addressPath',
);

// A chain of synthetic ids with no real ancestor cannot be resolved, so any path
// built from it would be an address that does not work.
const unanchoredLeaf = fakeNode({ id: 'I900:1;2:2;3:3', name: 'unanchored', type: 'FRAME', parent: null });
const unanchoredParent = fakeNode({ id: 'I900:1;2:2', name: 'unanchored parent', type: 'FRAME', parent: unanchoredLeaf });
check(
  'a synthetic chain with no real anchor reports no path',
  serialize(unanchoredParent).out.addressPath === undefined,
  JSON.stringify(serialize(unanchoredParent).out.addressPath),
);

const plainNode = serialize(fakeNode({ id: '885:1924', name: 'plain', type: 'FRAME' }));
check(
  'a normal id is left alone',
  plainNode.out.instanceScoped === undefined && plainNode.out.addressPath === undefined,
  JSON.stringify(plainNode.out),
);

console.log(
  failures === 0
    ? '\nAll serializer checks passed.\n'
    : `\n${failures} serializer check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
