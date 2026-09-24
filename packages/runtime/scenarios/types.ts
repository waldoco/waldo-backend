// Shared scenario format (SCENARIO_HARNESS_SPEC_2026-09-25). One catalog serves both layers:
// L1 drives turns with the scripted gateway and checks tools, hops, state and replies exactly;
// L2 replays the same cases with a live model and judges the rubric.
import type { ScriptRule } from '../src/testing/scripted-gateway';

export type ScenarioCategory =
  | 'tools' | 'memory' | 'scheduler' | 'degradation' | 'injection' | 'approvals' | 'voice' | 'clinical' | 'fetch';

// Trace assertion over the turn's hop stream (the same feed traceBook persists live).
export type HopAssert = Readonly<{
  hop: string;              // 'llm_reply', 'memory', 'tool_query_calendar', ...
  ok?: boolean;             // required outcome when given
  note?: RegExp;            // matched against the hop's error/detail text
  maxMs?: number;           // wall-clock bound
  after?: string;           // this hop must land after the named hop
}>;

export type StateAssert =
  | Readonly<{ kind: 'reminder_count'; equals: number }>
  | Readonly<{ kind: 'reminder_note'; matches: RegExp }>;

export type FixtureEvent = Readonly<{ id: string; title: string; start: string; end: string; all_day: boolean }>;
export type FixtureMail = Readonly<{ id: string; from: string; subject: string; snippet: string; at: string }>;
export type FixtureWeb = Readonly<{ title: string; url: string; snippet: string }>;

// A turn is owner text; the '@plan ' and '@prompt ' prefixes drive the planning and proactive
// entry points, matching the evals runner's convention.
export type Scenario = Readonly<{
  id: string;
  category: ScenarioCategory;
  turns: readonly string[];
  // L1: the scripted model. One rule per turn, matched against the owner text; rounds are the
  // tool calls then the final text. Scenarios for L2-only (rubric-graded voice/clinical) omit it.
  llm?: readonly ScriptRule[];
  rubric?: string;
  fixtures?: Readonly<{
    events?: readonly FixtureEvent[];
    mail?: readonly FixtureMail[];
    web?: readonly FixtureWeb[];
  }>;
  assert?: Readonly<{
    mustCall?: readonly string[];
    mustNotCall?: readonly string[];
    hops?: readonly HopAssert[];
    state?: readonly StateAssert[];
    // One entry per turn; an entry may be a single matcher or several, all must match that turn's reply.
    replies?: readonly (string | RegExp | readonly (string | RegExp)[])[];
  }>;
}>;
