import type { ToolDispatcherContext } from './dispatcher';

// Host-only currentness check at every client operation, including operations after
// awaited authentication and multi-page reads. The original client remains the receiver.
export const taskSourceClient = <T extends object>(client: T, ctx?: ToolDispatcherContext): T => !ctx?.assertTaskSourceCurrent ? client : new Proxy(client, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      await ctx.assertTaskSourceCurrent!();
      const result = await Reflect.apply(value, target, args);
      await ctx.assertTaskSourceCurrent!();
      return result;
    };
  },
});

export const taskSourceFetch = (assertCurrent: (() => Promise<void>) | undefined, fetcher: typeof fetch = fetch): typeof fetch => !assertCurrent ? fetcher : async (input, init) => {
  await assertCurrent();
  return fetcher(input, init);
};
