// What memory keeps about the owner's health, for every writer: remember's description, and the background passes' rules.
// What the owner says may be kept, numbers included; a stated reading is a moment, dated in its own words, because device
// data is read live and wins for anything current. Which text is health, and what the owner said, is the model's judgment.
export const HEALTH_MEMORY_RULES = [
  'Health: keep what the owner tells you about their own health, numbers included: how they feel, their routines, their goals and the readings they state.',
  'A reading the owner states (a resting heart rate, hours slept, a weight, a lab result) is a moment, not a standing fact: write it with the day they said it, like "On 22 Oct said resting HR was 52". A newer reading is a new claim; the older one stays as history. A goal or target is a standing claim the owner can replace.',
  'Never copy readings from a wearable or health app into memory: they are read live with get_health.',
  'Only what the owner said: never a condition or diagnosis Waldo inferred, never a government or insurance id, never a medication dose, and never someone else\'s health unless the owner asks you to remember it.',
];
