// Whether a tool call runs in a turn that has read outside text.
export const turnReadOutside = (ctx: Readonly<{ toolArgSourceTaint?: unknown }> | undefined): boolean => ctx?.toolArgSourceTaint === 'external';
// Whether the owner asked for a call in their own words: the turn was started by the owner's own message alone (the host sets
// ownerMessage only then, never for quotes or forwards), every part of it is their own words (a transcript of a file they sent
// may be someone else speaking, and a media note describes what someone else made), the turn has read nothing from outside, and
// nothing it carries from before (the conversation the model reads, recalled notes and messages) may be someone else's words:
// an email read last turn can't steer an "ok, handle it" now into a send with no card. Whether a call is what the owner
// asked for is the model's judgment; what code holds to is that nothing an email, page or tool answer said can reach here.
export const ownerAsked = (ctx: Readonly<{ ownerMessage?: Readonly<{ ownWordsOnly?: boolean }>; runOrigin?: unknown; toolArgSourceTaint?: unknown; carriedOutside?: boolean }> | undefined): boolean =>
  ctx?.ownerMessage?.ownWordsOnly === true && ctx.runOrigin === 'owner' && !turnReadOutside(ctx) && ctx.carriedOutside !== true;
