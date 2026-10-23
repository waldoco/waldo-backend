// The nightly catalogue, in run order: the research tasks and the owner's additions, the voice and safety set, then
// the errands parity set's runnable tasks, then the state and memory cases.
import { ERRAND_SCENARIOS } from './errands';
import { COMPACTION_SCENARIOS } from './long-conversation';
import { STATE_MEMORY_SCENARIOS } from './state-memory-scenarios';
import { SCENARIOS, type NightlyScenario } from './scenarios';
import { VOICE_SCENARIOS } from './voice-scenarios';

export const NIGHTLY_SCENARIOS = [...SCENARIOS, ...VOICE_SCENARIOS, ...ERRAND_SCENARIOS, ...STATE_MEMORY_SCENARIOS];

// The compaction probes of the ADR draft's section 6 start past the model's window, so each of their turns costs several
// times an ordinary one. They run only in the compaction flip pair, which names the switch: WALDO_EVAL_COMPACTION=off for
// the baseline, then =on. The default nightly leaves it unset and runs without them.
export const nightlyScenarios = (env: Readonly<{ WALDO_EVAL_COMPACTION?: string }>): readonly NightlyScenario[] =>
  env.WALDO_EVAL_COMPACTION === 'on' || env.WALDO_EVAL_COMPACTION === 'off' ? [...NIGHTLY_SCENARIOS, ...COMPACTION_SCENARIOS] : NIGHTLY_SCENARIOS;

// The raw-history baseline runs the memory cases whose facts arrive in owner turns; a seeded claim store has no
// raw-history equivalent, so those cases are left out rather than failed by construction.
export const rawHistoryScenarios = (scenarios: readonly NightlyScenario[]) => scenarios.filter((scenario) => scenario.memory_case && !scenario.world.memory?.length);
