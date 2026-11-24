// The autonomy switches set off. They are kept switches, so a deploy may run with them off, and then work the owner asked for
// goes to a card. A test that proves that card path sets these on the env it builds rather than inheriting the Worker config.
export const AUTONOMY_OFF = { AUTONOMOUS_BY_DEFAULT: '0', AUTONOMY_OWNER_TURNS: '0', AUTONOMY_OWN_CALENDAR: '0', APPROVE_IN_CHAT: '0' } as const;
