// What a run may do and send follows two facts that can differ. Its mark (toolArgSourceTaint) says whether it has read text
// someone else wrote. Its authority class (runOrigin 'external') is that of a run over outside content, held from its start
// for every run Waldo starts whose prompt the caller could not vouch for, and also for one whose mark only follows its reads.
// Either one makes the taint gate card its changes and fences what it sends out; only the mark is recorded on what it writes.
export const actsOnOutside = (ctx: Readonly<{ toolArgSourceTaint?: unknown; runOrigin?: unknown }> | undefined): boolean =>
  ctx?.toolArgSourceTaint === 'external' || ctx?.runOrigin === 'external';
