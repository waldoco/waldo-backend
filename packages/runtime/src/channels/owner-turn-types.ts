import type { CostKind } from '../llm/cost-ledger';
import type { ModelUsage } from '../llm/pricing';

// What fills one model call, in UTF-8 bytes: numeric metadata only, never text.
export type SystemSection = 'reasons' | 'behavior' | 'health' | 'clock' | 'memory' | 'orders' | 'loops' | 'skill_catalog' | 'task_context' | 'connections' | 'skill_procedures';
export type ContextShape = Readonly<{
  tools_count: number; tools_bytes: number; tool_turns_bytes: number;
  history_messages: number; history_bytes: number; current_bytes: number; attachments: number;
  system_sections?: Readonly<Partial<Record<SystemSection, number>>>;
}>;
export type TurnLogEntry = Readonly<{ trace: string; hop: string; owner?: string; owner_id?: string; owner_email?: string; owner_identity?: 'verified' | 'email_unavailable' | 'unknown'; ms: number; ok: boolean; error?: string; detail?: string; code?: string; guard?: string; usage?: ModelUsage; cost_kind?: CostKind; responsibility_id?: string; shape?: Readonly<{ system_bytes: number; request_bytes: number; context?: ContextShape }>; text?: TurnText }>;
export type TurnText = Readonly<{ input: string; output?: string; reasoning?: string }>;
export type TurnTimer = <T>(hop: string, work: () => Promise<T>) => Promise<T>;
