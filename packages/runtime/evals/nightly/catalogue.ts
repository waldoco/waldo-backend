// The nightly catalogue, in run order: the research tasks and the owner's additions, the voice and safety set, then
// the errands parity set's runnable tasks.
import { ERRAND_SCENARIOS } from './errands';
import { SCENARIOS } from './scenarios';
import { VOICE_SCENARIOS } from './voice-scenarios';

export const NIGHTLY_SCENARIOS = [...SCENARIOS, ...VOICE_SCENARIOS, ...ERRAND_SCENARIOS];
