// What memory keeps about the owner's health, for every writer: remember's description, and the background passes' rules.
// What the owner says may be kept, numbers included; a stated reading is a moment, dated in its own words, because device
// data is read live and wins for anything current. Which text is health, and what the owner said, is the model's judgment.
export const HEALTH_MEMORY_RULES = [
  'Health: keep what the owner tells you about their own health, numbers included: how they feel, their routines, their goals and the readings they state.',
  'A reading the owner states (a resting heart rate, hours slept, a weight, a lab result) is a moment, not a standing fact: write it with the day they said it, like "On 22 Oct said resting HR was 52". A newer reading is a new claim; the older one stays as history. A goal or target is a standing claim the owner can replace.',
  'Never copy readings from a wearable or health app into memory: they are read live with get_health.',
  'Only what the owner said: never a condition or diagnosis Waldo inferred, never a government or insurance id, never a medication dose, and never someone else\'s health unless the owner asks you to remember it.',
];
// A stated sleep need is never kept in memory. The rule names no store, since the health settings that keep it are offered only
// while coaching is on, so its words hold with coaching on or off. The background writers carry the rule with the
// others; in chat it is in the system prompt's Remembering section, which every owner turn reads, because remember's description
// is at the 1,024-character cap and set_sleep_need's is not offered while coaching is off or its namespace is deferred.
export const SLEEP_NEED_MEMORY_RULE = 'Never keep a figure for the owner\'s sleep need in memory, at most that they stated one.';
// A medicine the owner tracks lives in their medicine list on the health plane (ADR-0081, 1 November 2026); memory keeps at most
// that they track one. The background writers carry it with the others; in chat it is in track_medication's description, which the
// model reads whenever it tracks one.
export const MEDICATION_MEMORY_RULE = 'Never keep the name or times of a medicine the owner tracks in memory, at most that they track medicines.';
export const PASS_HEALTH_MEMORY_RULES = [...HEALTH_MEMORY_RULES, SLEEP_NEED_MEMORY_RULE, MEDICATION_MEMORY_RULE];
