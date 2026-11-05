import { toolsWhere } from '../tools/records';

// The owner's chat turn as a router (docs/proposals/WALDO_ASYNC_TOOLS_DESIGN_2026-11-04.md). With WALDO_ASYNC_TOOLS=1 the
// owner's own turn holds no long tool: work that outlasts a model step goes to start_task, whose worker holds the tool, and
// the turn answers at once. Whether a piece of work becomes a task stays the model's call. Off unless "1".
export const asyncToolsEnabled = (env: Readonly<{ WALDO_ASYNC_TOOLS?: string }>): boolean => env.WALDO_ASYNC_TOOLS === '1';
export const OWNER_TURN_LONG_TOOLS: ReadonlySet<string> = toolsWhere((record) => record.long);

// With WALDO_LIGHT_CHAT=1 the owner's own reply runs on the provider's auxiliary model and every task worker on its chat
// model: the router talks, the workers do the work. Off unless "1".
export const lightChatEnabled = (env: Readonly<{ WALDO_LIGHT_CHAT?: string }>): boolean => env.WALDO_LIGHT_CHAT === '1';
