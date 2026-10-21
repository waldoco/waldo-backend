// The nightly catalogue, in run order: the research tasks and the owner's additions, then the voice and safety set.
import { SCENARIOS } from './scenarios';
import { VOICE_SCENARIOS } from './voice-scenarios';

export const NIGHTLY_SCENARIOS = [...SCENARIOS, ...VOICE_SCENARIOS];
