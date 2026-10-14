import type { ToolName } from '@waldo/contracts';
import { TOOL_REPLAY_CLASS } from '../hooks/tool-replay-class';

// A background step must know whether it reached anything but a safe read before its handler runs, so an interruption
// can be told apart: a step that only read may run again, one that may have acted may not. The runner watches its own
// attempt's turn id; the id is unique per attempt, so owner objects sharing an isolate never see each other's calls.
const watchers = new Map<string, () => void>();

export const watchEffects = (turnId: string, onEffect: () => void): (() => void) => {
  watchers.set(turnId, onEffect);
  return () => { watchers.delete(turnId); };
};

export const noteDispatch = (turnId: string | undefined, tool: ToolName): void => {
  if (turnId === undefined || TOOL_REPLAY_CLASS[tool].replay === 'safe_read') return;
  watchers.get(turnId)?.();
};
