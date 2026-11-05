// The nightly catalogue, in run order: the research tasks and the owner's additions, the voice and safety set, then
// the errands parity set's runnable tasks, then the state and memory cases, then the personality cases, then the health set, then the Brief
// and health-only-day set, then the other day cards, then mail triage, then the proactive skills, then Waldo tidying its own approval cards, then
// writing for the medium and planning ahead, then the light-chat routing set, then the welcome build, then the long conversation compaction is measured on.
import { APPROVAL_SCENARIOS } from './approval-scenarios';
import { ERRAND_SCENARIOS } from './errands';
import { BRIEF_HEALTH_SCENARIOS } from './brief-health-scenarios';
import { CARD_SCENARIOS } from './card-scenarios';
import { TRIAGE_SCENARIOS } from './triage-scenarios';
import { HEALTH_SCENARIOS } from './health-scenarios';
import { LIGHT_CHAT_SCENARIOS } from './light-chat-scenarios';
import { MEMORY_FINAL_SCENARIOS } from './memory-final-scenarios';
import { LONG_CONVERSATION_SCENARIO } from './long-conversation';
import { PERSONALITY_SCENARIOS } from './personality-scenarios';
import { STATE_MEMORY_SCENARIOS } from './state-memory-scenarios';
import { SCENARIOS, type NightlyScenario } from './scenarios';
import { SKILL_SCENARIOS } from './skill-scenarios';
import { VOICE_SCENARIOS } from './voice-scenarios';
import { WELCOME_SCENARIOS } from './welcome-scenarios';
import { WRITING_SCENARIOS } from './writing-scenarios';

export const NIGHTLY_SCENARIOS = [...SCENARIOS, ...VOICE_SCENARIOS, ...ERRAND_SCENARIOS, ...STATE_MEMORY_SCENARIOS, ...MEMORY_FINAL_SCENARIOS, ...PERSONALITY_SCENARIOS, ...HEALTH_SCENARIOS, ...BRIEF_HEALTH_SCENARIOS, ...CARD_SCENARIOS, ...TRIAGE_SCENARIOS, ...SKILL_SCENARIOS, ...APPROVAL_SCENARIOS, ...WRITING_SCENARIOS, ...LIGHT_CHAT_SCENARIOS, ...WELCOME_SCENARIOS, LONG_CONVERSATION_SCENARIO];

// The raw-history baseline runs the memory cases whose facts arrive in owner turns; a seeded claim store has no
// raw-history equivalent, so those cases are left out rather than failed by construction.
export const rawHistoryScenarios = (scenarios: readonly NightlyScenario[]) => scenarios.filter((scenario) => scenario.memory_case && !scenario.world.memory?.length);
