/**
 * Ambient bridge for the shared wire types.
 *
 * The plugin's main entry must compile to a *script*, not a module: Figma loads
 * `main` as a classic script, so an emitted `export {}` (which TypeScript adds
 * to a module under `isolatedModules`) is a hard syntax error inside Figma.
 *
 * Importing `@dsh-figma/protocol` directly in `code.ts` would make that file a
 * module and reintroduce the problem. Declaration files emit nothing, so this
 * file re-exports the shared types into the global scope instead: `code.ts`
 * stays import-free while the type definitions still have a single source of
 * truth. `scripts/verify-bundle.mjs` asserts the resulting invariant on every
 * build.
 */

import type * as Shared from '@dsh-figma/protocol';

declare global {
  /** See {@link Shared.PluginIdentity}. */
  type PluginIdentity = Shared.PluginIdentity;
  /** See {@link Shared.CommandError}. */
  type CommandError = Shared.CommandError;
  /** See {@link Shared.CommandRequest}. */
  type CommandRequest = Shared.CommandRequest;
  /** See {@link Shared.CommandResult}. */
  type CommandResult = Shared.CommandResult;
  /** See {@link Shared.PollRequest}. */
  type PollRequest = Shared.PollRequest;
  /** See {@link Shared.PollResponse}. */
  type PollResponse = Shared.PollResponse;

  /* Write operations — see {@link Shared.ApplyOp} and friends. */
  /** See {@link Shared.LayoutMode}. */
  type LayoutMode = Shared.LayoutMode;
  /** See {@link Shared.Sizing}. */
  type Sizing = Shared.Sizing;
  /** See {@link Shared.PrimaryAlign}. */
  type PrimaryAlign = Shared.PrimaryAlign;
  /** See {@link Shared.CounterAlign}. */
  type CounterAlign = Shared.CounterAlign;
  /** See {@link Shared.ChildAlign}. */
  type ChildAlign = Shared.ChildAlign;
  /** See {@link Shared.LayoutWrap}. */
  type LayoutWrap = Shared.LayoutWrap;
  /** See {@link Shared.TextAlignHorizontal}. */
  type TextAlignHorizontal = Shared.TextAlignHorizontal;
  /** See {@link Shared.TextAlignVertical}. */
  type TextAlignVertical = Shared.TextAlignVertical;
  /** See {@link Shared.TextAutoResize}. */
  type TextAutoResize = Shared.TextAutoResize;
  /** See {@link Shared.CreatableNodeType}. */
  type CreatableNodeType = Shared.CreatableNodeType;
  /** See {@link Shared.PaintSpec}. */
  type PaintSpec = Shared.PaintSpec;
  /** See {@link Shared.LayoutSpec}. */
  type LayoutSpec = Shared.LayoutSpec;
  /** See {@link Shared.TextStyleSpec}. */
  type TextStyleSpec = Shared.TextStyleSpec;
  /** See {@link Shared.TextSpec}. */
  type TextSpec = Shared.TextSpec;
  /** See {@link Shared.NodeSpec}. */
  type NodeSpec = Shared.NodeSpec;
  /** See {@link Shared.NodePatch}. */
  type NodePatch = Shared.NodePatch;
  /** See {@link Shared.ApplyOp}. */
  type ApplyOp = Shared.ApplyOp;
  /** See {@link Shared.ApplyResult}. */
  type ApplyResult = Shared.ApplyResult;

  /* Design tokens — see {@link Shared.TokensResult}. */
  /** See {@link Shared.TokenAction}. */
  type TokenAction = Shared.TokenAction;
  /** See {@link Shared.TokenVariableType}. */
  type TokenVariableType = Shared.TokenVariableType;
  /** See {@link Shared.TokenMode}. */
  type TokenMode = Shared.TokenMode;
  /** See {@link Shared.TokenCollection}. */
  type TokenCollection = Shared.TokenCollection;
  /** See {@link Shared.TokenVariable}. */
  type TokenVariable = Shared.TokenVariable;
  /** See {@link Shared.TokenAuditFinding}. */
  type TokenAuditFinding = Shared.TokenAuditFinding;
  /** See {@link Shared.TokenBindRequest}. */
  type TokenBindRequest = Shared.TokenBindRequest;
  /** See {@link Shared.TokenCreateRequest}. */
  type TokenCreateRequest = Shared.TokenCreateRequest;
  /** See {@link Shared.TokensResult}. */
  type TokensResult = Shared.TokensResult;
}

export {};
