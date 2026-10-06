import type { BrowserTaskProposal, BrowserTaskCheckpoint } from '@waldo/contracts';
import type { BrowserTaskDriver, BrowserTaskStore } from './browser-task-continuity';
import type { BrowserSubmitOutcome } from '../tools/live/browser';
import type { FixtureObservation, BrowserSourceGuard } from './public-fixture-browser';
export type BrowserGateCommand =
  | { operation: 'goto'; url: string; intent?: 'read' | 'send' }
  | { operation: 'click'; element_ref: string; intent?: 'read' | 'send' }
  | { operation: 'type'; element_ref: string; value?: string; key?: 'Enter'; intent?: 'read' | 'send' }
  | { operation: 'scroll'; delta: number; intent?: 'read' | 'send' }
  | { operation: 'read'; intent?: 'read' | 'send' }
  | { operation: 'wait'; milliseconds: number; intent?: 'read' | 'send' };
export type BrowserGateObservation = Readonly<{
  url: string; text: string;
  elements: readonly Readonly<{ ref: string; tag: 'a' | 'button' | 'input'; type?: string; field?: string; href?: string; inForm: boolean }>[];
  form: Readonly<{ action: string; method: string; values: Readonly<Record<string, string>> }>;
}>;
export type BrowserGateDriverPort = Readonly<{
  start(lifetimeMs: number, allowRequest: (request: Readonly<{ url: string; method: string; body?: string }>) => boolean): Promise<string>;
  observe(id: string): Promise<BrowserGateObservation>;
  execute(id: string, command: BrowserGateCommand, expectedDigest: string, before: BrowserSourceGuard, assertCurrent?: () => void): Promise<void>;
  close(id: string): Promise<void>; absent(id: string): Promise<boolean>;
  verify(bindingDigest: string): ReturnType<BrowserTaskDriver['verify']>;
}>;
export type BrowserGateSessionDriver = BrowserTaskDriver & Readonly<{
  command(id: string, command: BrowserGateCommand, stateDigest: string, before: BrowserSourceGuard, source?: BrowserSourceGuard, assertCurrent?: () => void): Promise<{ held: boolean; nativeSubmit?: boolean }>;
}>;
export type BrowserGateCommandResult = { held: true; proposal: BrowserTaskProposal; approvalRef: string } | { held: true; reason: 'declared_send_unsupported' } | { held: false; snapshot: FixtureObservation };
export type BrowserGate = Readonly<{
  command(owner: string, command: BrowserGateCommand): Promise<BrowserGateCommandResult>;
  approve(owner: string, proposalId: string, approvalRef: string): Promise<BrowserSubmitOutcome>;
  deny(owner: string, proposalId: string): Promise<void>;
  finishRun(owner: string): Promise<void>;
  expire(owner: string): Promise<void>;
}>;
export type BrowserGateStore = BrowserTaskStore;
export type BrowserGateCheckpoint = BrowserTaskCheckpoint;
export type BrowserGateApprovalStore = Readonly<{
  // Adapt the existing approval desk ledger; no second persisted approval book.
  create(proposal: BrowserTaskProposal): Promise<string>;
  // Claim the existing owner ledger row exactly once, checking its digest/expiry.
  consume(ownerId: string, proposal: BrowserTaskProposal, approvalRef: string): Promise<boolean>;
}>;
export type BrowserGateOptions = Readonly<{
  enabled: boolean; ownerId: string; manifestDigest: string;
  driver: BrowserGateSessionDriver; store: BrowserGateStore; approvals: BrowserGateApprovalStore;
  now(): number; newId(): string;
  admit(operation: 'navigate' | 'observe' | 'extract' | 'act' | 'end', evidence?: Readonly<{ actionDigest?: string; bindingDigest?: string; stateDigest?: string; proposalId?: string; approvalRef?: string }>): Promise<string | null>;
}>;
