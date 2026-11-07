// One owner timeline across surfaces: with the switch on, the owner's WhatsApp turns read and write the same chain as their app
// chat, each row keeping the surface it was written on.
export const oneTimelineEnabled = (env: Readonly<{ WALDO_ONE_TIMELINE?: string }>): boolean => env.WALDO_ONE_TIMELINE === '1';
