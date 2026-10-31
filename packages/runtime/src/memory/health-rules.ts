// What memory keeps about the owner's health, for every writer: remember's description, and the background passes' rules.
// What the owner says may be kept, numbers included; a stated reading is a moment, dated in its own words, because device
// data is read live and wins for anything current. Which text is health, and what the owner said, is the model's judgment.
export const HEALTH_MEMORY_RULES = [
  'Health: keep what the owner tells you about their own health, numbers included: how they feel, their routines, their goals and the readings they state.',
  'A reading the owner states (a resting heart rate, hours slept, a weight, a lab result) is a moment, not a standing fact: write it with the day they said it, like "On 22 Oct said resting HR was 52". A newer reading is a new claim; the older one stays as history. A goal or target is a standing claim the owner can replace.',
  'Never copy readings from a wearable or health app into memory: they are read live with get_health.',
  'Only what the owner said: never a condition or diagnosis Waldo inferred, never a government or insurance id, never a medication dose, and never someone else\'s health unless the owner asks you to remember it.',
];
// The background writers' rules add the stated sleep need, which lives in the owner's health settings. remember's description
// carries only HEALTH_MEMORY_RULES: a tool description is capped at 1,024 characters and remember's is at the cap, so in chat the
// set_sleep_need description says the same thing.
export const SLEEP_NEED_MEMORY_RULE = 'The owner\'s sleep need belongs in their health settings (set_sleep_need, when offered), never in memory: memory keeps no figure for it, at most that they stated one.';
export const PASS_HEALTH_MEMORY_RULES = [...HEALTH_MEMORY_RULES, SLEEP_NEED_MEMORY_RULE];
