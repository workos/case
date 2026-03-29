import type { Static, TObject, TProperties } from '@sinclair/typebox';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';

/**
 * Type-safe tool definition helper that works around the typebox TSchema
 * constraint issue where TObject<T> doesn't structurally satisfy TSchema
 * in TypeScript's type checker (despite being correct at runtime).
 *
 * This lets each tool keep full type safety on `params` without needing
 * `as any` or `as TSchema` casts.
 */
export function defineTool<T extends TProperties>(config: {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: TObject<T>;
  execute: (
    toolCallId: string,
    params: Static<TObject<T>>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
}): ToolDefinition {
  // Safe cast: TObject<T> extends TSchema at runtime (has [Kind] symbol),
  // but TypeScript's structural checker can't verify the symbolic property.
  return config as unknown as ToolDefinition;
}
