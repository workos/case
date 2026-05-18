/**
 * Event describing a single tool invocation lifecycle event.
 * Emitted by agent adapters (e.g. pi-adapter) and consumed by the renderer.
 */
export interface ToolActivityEvent {
  type: 'start' | 'end';
  tool: string;
  args?: string;
  durationMs?: number;
  isError?: boolean;
}
