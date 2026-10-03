// Display labels describe recorded operations, never delivery or verified effects.
export const activityLabel = (kind:string) => ({
 update_card:'Update card', joined_path:'Conversation processing', llm_reply:'Chat reply',
 heartbeat:'Background check', reminder:'Reminder', patrol_skip:'Background check held',
 tool_attempt:'Tool attempt',
}[kind] ?? 'Recorded activity');
export const missingOutcome = 'No outcome summary recorded. This record does not confirm delivery or an external change.';
