import type { ModelUsage } from '../llm/pricing';

export type TurnLogEntry = Readonly<{ trace: string; hop: string; owner?: string; owner_id?: string; owner_email?: string; owner_identity?: 'verified' | 'email_unavailable' | 'unknown'; ms: number; ok: boolean; error?: string; detail?: string; code?: string; guard?: string; usage?: ModelUsage; shape?: Readonly<{ system_bytes: number; request_bytes: number }>; text?: TurnText }>;
export type TurnText = Readonly<{ input: string; output?: string; reasoning?: string }>;
export type TurnTimer = <T>(hop: string, work: () => Promise<T>) => Promise<T>;
