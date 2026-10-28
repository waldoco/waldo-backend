// The nightly catalogue, in run order: the research tasks and the owner's additions, the voice and safety set, then
// the errands parity set's runnable tasks, then the state and memory cases, then the personality cases, then the health set, then the Brief
// and health-only-day set, then the long conversation compaction is measured on.
import { ERRAND_SCENARIOS } from './errands';
import { BRIEF_HEALTH_SCENARIOS } from './brief-health-scenarios';
import { HEALTH_SCENARIOS } from './health-scenarios';
import { LONG_CONVERSATION_SCENARIO } from './long-conversation';
import { PERSONALITY_SCENARIOS } from './personality-scenarios';
import { STATE_MEMORY_SCENARIOS } from './state-memory-scenarios';
import { SCENARIOS, type NightlyScenario } from './scenarios';
import { VOICE_SCENARIOS } from './voice-scenarios';

export const NIGHTLY_SCENARIOS = [...SCENARIOS, ...VOICE_SCENARIOS, ...ERRAND_SCENARIOS, ...STATE_MEMORY_SCENARIOS, ...PERSONALITY_SCENARIOS, ...HEALTH_SCENARIOS, ...BRIEF_HEALTH_SCENARIOS, LONG_CONVERSATION_SCENARIO];

// The raw-history baseline runs the memory cases whose facts arrive in owner turns; a seeded claim store has no
// raw-history equivalent, so those cases are left out rather than failed by construction.
export const rawHistoryScenarios = (scenarios: readonly NightlyScenario[]) => scenarios.filter((scenario) => scenario.memory_case && !scenario.world.memory?.length);
