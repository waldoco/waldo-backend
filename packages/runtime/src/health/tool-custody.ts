// Host-only provenance. A model cannot forge this by naming get_health or adding
// fields to arguments/results. The map contains authority callbacks, no values.
const protectedReads = new WeakMap<object, () => Promise<void>>();
export const markProtectedHealthRead = <T extends object>(handler: T, assertCurrent: () => Promise<void>): T => {
  protectedReads.set(handler, assertCurrent); return handler;
};
export const protectedHealthReadCurrent = (handler: object): (() => Promise<void>) | undefined => protectedReads.get(handler);
