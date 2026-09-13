/**
 * Tool-result rendering — the single place that decides what the model sees.
 *
 * Kept apart from the MCP wiring so it can be tested directly: the image path
 * is the part most likely to break silently (a screenshot that fails to render
 * looks to the model exactly like a tool that returned nothing), and it is the
 * part that justifies this whole project.
 */

import {
  BridgeErrorCode,
  MAX_IMAGES_PER_RESULT,
  MAX_IMAGE_BASE64_CHARS,
  commandError,
  isImageBundle,
  isRenderableImage,
  type CommandError,
  type CommandResult,
  type ImageBundle,
  type ImagePayload,
} from '@dsh-figma/protocol';

/** Beyond this, tool output is truncated rather than flooding the model context. */
const MAX_TEXT_CHARS = 120_000;

/** Minimal MCP content block shapes; the SDK widens these at the call site. */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Turn one command outcome into MCP content.
 *
 * Three cases: a structured failure becomes an actionable message; an image
 * bundle becomes image blocks with captions; anything else becomes JSON text.
 */
export function contentForResult(toolName: string, result: CommandResult): McpContent[] {
  if (!result.ok) {
    return [
      {
        type: 'text',
        text: renderFailure(
          toolName,
          result.error ?? commandError(BridgeErrorCode.BridgeError, 'Unknown failure.'),
        ),
      },
    ];
  }

  if (isImageBundle(result.result)) return renderImages(result.result);

  return [
    {
      type: 'text',
      text: renderValue({ tool: toolName, durationMs: result.durationMs, result: result.result }),
    },
  ];
}

/** Render a structured failure so the model gets the fix, not just the fault. */
export function renderFailure(toolName: string, error: CommandError): string {
  const lines = [`"${toolName}" failed — ${error.code}`, error.message];
  if (error.hint !== undefined) lines.push(`Hint: ${error.hint}`);
  if (error.details !== undefined) lines.push(`Details: ${renderValue(error.details)}`);
  return lines.join('\n');
}

/** Serialize a value as text, truncating rather than flooding the context. */
export function renderValue(value: unknown): string {
  const text =
    typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
  if (text.length <= MAX_TEXT_CHARS) return text;
  const hidden = text.length - MAX_TEXT_CHARS;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n… truncated ${hidden} more characters. Narrow the scope of the request (smaller depth, fewer node ids) and try again.`;
}

/**
 * Attach images with a caption before each one.
 *
 * The caption precedes its image so the model can tie a picture to a node id
 * without having to count blocks, and the trailing block reports everything
 * that did not make it — a silently dropped screenshot is worse than a stated
 * refusal, because the model would otherwise assume it saw the current state.
 */
function renderImages(bundle: ImageBundle): McpContent[] {
  const content: McpContent[] = [];
  const trailing: string[] = [];

  const candidates = bundle.images.slice(0, MAX_IMAGES_PER_RESULT);
  const overCount = bundle.images.length - candidates.length;
  let droppedForSize = 0;

  for (const image of candidates) {
    if (!isRenderableImage(image) || image.base64.length > MAX_IMAGE_BASE64_CHARS) {
      droppedForSize += 1;
      continue;
    }
    content.push({ type: 'text', text: captionFor(image) });
    content.push({ type: 'image', data: image.base64, mimeType: image.mimeType });
  }

  if (overCount > 0) {
    trailing.push(
      `${overCount} more image(s) were not attached: at most ${MAX_IMAGES_PER_RESULT} images fit in one result. Ask for fewer nodes, or screenshot the containing frame instead.`,
    );
  }
  if (droppedForSize > 0) {
    trailing.push(
      `${droppedForSize} image(s) were dropped as unusable or larger than ${Math.round(MAX_IMAGE_BASE64_CHARS / 1_000_000)} MB of base64. Lower the scale.`,
    );
  }
  for (const skip of bundle.skipped) {
    trailing.push(
      `Not captured — ${skip.nodeName ?? 'node'} (${skip.nodeId}): ${skip.reason}`,
    );
  }
  for (const note of bundle.notes ?? []) trailing.push(note);

  if (content.length === 0) {
    content.push({
      type: 'text',
      text: `No image could be produced.${trailing.length > 0 ? `\n${trailing.join('\n')}` : ''}`,
    });
    return content;
  }

  if (trailing.length > 0) content.push({ type: 'text', text: trailing.join('\n') });
  return content;
}

function captionFor(image: ImagePayload): string {
  const kilobytes = Math.round(image.byteLength / 1024);
  return `${image.nodeName} (${image.nodeId}) — ${image.width}x${image.height} px at ${image.scale}x, ${kilobytes} KB`;
}
