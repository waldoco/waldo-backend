// The nightly catalogue, in run order: the research tasks and the owner's additions, the voice and safety set, then
// the errands parity set's runnable tasks, then the state and memory cases, then the compaction probes of the ADR draft's
// section 6.
import { ERRAND_SCENARIOS } from './errands';
import { COMPACTION_SCENARIOS } from './long-conversation';
import { STATE_MEMORY_SCENARIOS } from './state-memory-scenarios';
import { SCENARIOS, type NightlyScenario } from './scenarios';
import { VOICE_SCENARIOS } from './voice-scenarios';

export const NIGHTLY_SCENARIOS = [...SCENARIOS, ...VOICE_SCENARIOS, ...ERRAND_SCENARIOS, ...STATE_MEMORY_SCENARIOS, ...COMPACTION_SCENARIOS];

// The raw-history baseline runs the memory cases whose facts arrive in owner turns; a seeded claim store has no
// raw-history equivalent, so those cases are left out rather than failed by construction.
export const rawHistoryScenarios = (scenarios: readonly NightlyScenario[]) => scenarios.filter((scenario) => scenario.memory_case && !scenario.world.memory?.length);
