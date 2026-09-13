/**
 * The model-facing tool surface.
 *
 * Kept deliberately small. Every tool defined here costs tokens in every single
 * request, and DSH namespaces these as `mcp__figma__<name>`. One semantic tool
 * that takes a rich payload beats ten narrow ones — so the writing tools added
 * in later phases are `apply`, `text`, `tokens`, `components`, and one escape
 * hatch, not one tool per Figma API method.
 *
 * Descriptions are prompt surface: they are written to tell the model *when* to
 * reach for the tool, not just what it does.
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: ToolAnnotations;
}

/** No arguments, so every parameter-less tool shares one empty schema. */
const NO_ARGS = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'status',
    title: 'Figma link status',
    description:
      'Report the live state of the connected Figma plugin: file name, current page, the user\'s current selection, and which commands this plugin build supports. ' +
      'Call this first — before any other Figma tool — to confirm the link works and to learn what the user is looking at. ' +
      'Call it again whenever a Figma tool fails, because it distinguishes "no plugin is running" from "the plugin is running but rejected the command". ' +
      'Read-only: it never modifies the document.',
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ping',
    title: 'Round-trip link check',
    description:
      'Send a small payload to the Figma plugin and read it back, measuring round-trip latency. ' +
      'Use it to verify the bridge link in isolation, or to tell a slow connection apart from a slow Figma operation. ' +
      'It does not read or modify the document, so it is the safe choice when you only need to know whether the plugin is responsive.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        echo: {
          type: 'string',
          description: 'Any string; returned unchanged. Useful for correlating a specific call.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'describe',
    title: 'Read the canvas',
    description:
      'Read the Figma canvas as structured JSON: a depth-limited tree of nodes with id, type, name, bounds, auto-layout settings, fills, text content, and any variable bindings. ' +
      'This is how you find out what is actually on the canvas before changing anything — never guess at node ids or structure. ' +
      'Defaults to the current selection. Pass scope "page" to list the current page\'s top-level nodes, or nodeIds to read specific nodes by id. ' +
      'Auto-layout is reported in Figma\'s own terms (layoutMode, itemSpacing, padding, layoutSizing), so what you read here is what a later write has to match. ' +
      'A property whose value is the string "mixed" means the runs of a text node disagree about it (a mixed font size, a mixed fill) — the property exists and varies, which is a different fact from its being absent, and it decides whether an edit is safe. ' +
      'Truncation is reported explicitly, and says which limit was hit: `depthLimited` (raise `depth`) or `countLimited` (read narrower, or use `fields`). ' +
      'Read-only: it never modifies the document.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['selection', 'page'],
          description:
            'What to read when nodeIds is absent. "selection" (default) reads the user\'s current selection; "page" reads the current page\'s top-level nodes.',
        },
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Specific node ids to read, e.g. ["1:23"]. Overrides scope. Ids are stable for the lifetime of a node but change when it is recreated.',
        },
        depth: {
          type: 'number',
          description:
            'How many levels of children to include. Default 3, max 8. Depth is where token cost explodes — start shallow and go deeper only on the branch you care about.',
        },
        limit: {
          type: 'number',
          description: 'Maximum nodes to return in total. Default 200, max 400.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional projection: return only these top-level keys per node, e.g. ["id","name","layout"]. Useful when the tree is large and you need only part of each node.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'screenshot',
    title: 'Screenshot the canvas',
    description:
      'Export nodes from Figma as images that you can actually look at. ' +
      'This is the only way to see the true result of your own edits: call it after any change to a visual property, and before telling the user a design is correct. ' +
      'Reading JSON describes what the document says; a screenshot shows what the user sees, including overflow, clipping, weak contrast, misalignment, and text that wrapped badly. ' +
      'Defaults to the current selection, falling back to the page\'s top-level frames when nothing is selected. ' +
      'Returns up to 4 images, each preceded by a caption giving its node id, pixel size, and scale. Nodes that could not be exported are listed explicitly with the reason — read that list, because a missing screenshot is not the same as an empty canvas. ' +
      'Read-only: it never modifies the document.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Nodes to export, e.g. ["1:23"]. Defaults to the current selection. Prefer exporting a containing frame over many small children.',
        },
        scale: {
          type: 'number',
          description:
            'Export scale between 0.25 and 4. Default 2. Automatically reduced to stay within the pixel budget; the effective scale is reported in each caption.',
        },
        format: {
          type: 'string',
          enum: ['PNG', 'JPG'],
          description:
            'Image format. Default PNG (lossless, best for reading text). Use JPG only for photographic content.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'apply',
    title: 'Edit the canvas',
    description:
      'Apply a batch of declarative edits to the Figma canvas: create nodes, update properties, move, rename, or delete. ' +
      'ONE CALL IS ONE UNDO STEP, so build an entire screen in a single call instead of many small ones — the user should need one undo, not forty. ' +
      'Properties use the same vocabulary `describe` reports, so what you read is what you write: layout.mode / itemSpacing / padding / primaryAxisAlign / counterAxisAlign for a container, and layout.sizing / grow / align for a node inside its parent\'s auto-layout. Fills are hex strings ("#722ed1", "#rrggbbaa"). ' +
      'Unknown property names are REJECTED rather than ignored, so a typo fails loudly instead of leaving you believing you set something you did not. ' +
      'A create op may nest `children` inline to build a whole tree, and may carry a `ref`; later ops in the same call address it as "ref:name", which is how you attach something to a node created moments earlier. ' +
      'After applying, call `screenshot` on what you changed before telling the user the design is correct: the JSON says what the document claims, the picture says what the user sees. ' +
      'If an op fails, the error names the failing op index and lists what was already created — those nodes are on the canvas whether or not you are told about them, so read that list before retrying.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ops: {
          type: 'array',
          description:
            'Operations, applied in order. Each is one of: {op:"create", ref?, parentId?, node:{type, name?, x?, y?, width?, height?, layout?, fills?, strokes?, strokeWeight?, cornerRadius?, opacity?, visible?, clipsContent?, text?, children?[]}} | {op:"update", id, props:{...same node properties minus type/children}} | {op:"move", id, x?, y?, parentId?, index?} | {op:"rename", id, name} | {op:"delete", id}.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['create', 'update', 'move', 'rename', 'delete'],
                description: 'Which operation this entry is.',
              },
            },
            required: ['op'],
          },
        },
      },
      required: ['ops'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'tokens',
    title: 'Design variables',
    description:
      'Read and write Figma Variables (design tokens) in this file. ' +
      'This matters because a hard-coded value and a token-bound value look identical in a screenshot and identical in `describe` unless the binding is reported — so an unbound literal is a maintenance bug, not a visual one, and it is invisible without asking. ' +
      'Actions: "list" reads the collections and variables with their values and the modes they define, including library tokens found by walking the document; "audit" scans nodes and reports unbound literals, naming the candidate variable whenever one already holds exactly that value; "bind" attaches a variable to a node property; "create" adds variables into a new or existing collection; "delete" removes variables or whole collections. ' +
      'Binding changes how a value is sourced. It renders identically only when the new variable already holds the same value — binding an unbound literal to a same-valued token changes nothing on the canvas, but rebinding to a token with a different value does — so re-read with describe, or screenshot, to confirm what it now resolves to. ' +
      'A `nodeId` may be an id path such as "885:1923/76:646/80:825". A layer inside an instance has a synthetic id ("I…;…;…") that Figma refuses to resolve, and a path from the instance is the only way to address one. describe reports those nodes with `instanceScoped: true`. ' +
      'Bind colors through `fills` or `strokes` (per-paint), and numbers through fields like itemSpacing, paddingLeft, cornerRadius, strokeWeight, width, or opacity.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'audit', 'bind', 'create', 'delete'],
          description: 'What to do: read the file\'s variables, find unbound literals, attach variables, add new ones, or remove them.',
        },
        nameContains: { type: 'string', description: '"list": only variables whose name contains this text.' },
        type: { type: 'string', enum: ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'], description: '"list": only variables of this type.' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: '"audit" / "list" / "delete": nodes to walk. Defaults to the selection, then to the page\'s top-level nodes. A nodeId may be an id path.' },
        depth: { type: 'number', description: 'How deep to descend. Default 2 (4 for "list"), max 8.' },
        limit: { type: 'number', description: 'Maximum nodes to scan. Default 200, max 400.' },
        collection: { type: 'string', description: '"create": name of a NEW collection to create.' },
        collectionId: { type: 'string', description: '"create": id of an EXISTING collection to add into.' },
        variables: {
          type: 'array',
          description: '"create": [{ name, type, value, description? }]. COLOR takes "#rrggbb"; FLOAT a number; STRING text; BOOLEAN true/false.',
          items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' } }, required: ['name', 'type'] },
        },
        bindings: {
          type: 'array',
          description: '"bind": [{ nodeId, field, variableId, paintIndex? }]. `field` is "fills" / "strokes" for a colour, or a numeric field name.',
          items: { type: 'object', properties: { nodeId: { type: 'string' }, field: { type: 'string' }, variableId: { type: 'string' } }, required: ['nodeId', 'field', 'variableId'] },
        },
        variableIds: { type: 'array', items: { type: 'string' }, description: '"delete": variables to remove. A variable that is still bound anywhere is refused, because removing it would orphan that binding.' },
        collectionIds: { type: 'array', items: { type: 'string' }, description: '"delete": collections to remove, along with the variables inside them.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
