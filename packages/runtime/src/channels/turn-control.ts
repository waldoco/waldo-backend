// Stop and steer (W6). A turn runs as rounds of model calls; between rounds the owner can stop it
// or add direction. Anything the running turn saw is absorbed, so it is not answered twice.
export const STOPPED_REPLY = 'Stopped. Nothing more on that one.';

export const turnControl = () => {
  let running = false;
  let target: string | null = null;
  let steerable = false;
  let stopped = false;
  let pending: { id: number; text: string }[] = [];
  let heard: string[] = [];
  const absorbed = new Set<number>();
  let consume: ((ids: readonly number[]) => Promise<void>) | undefined;
  return {
    bindTarget(id: string): void { target = id; },
    stopTarget(id: string): boolean { if (target !== id || !running) return false; stopped = true; return true; },
    steerTarget(targetId: string, id: number, text: string): boolean {
      if (target !== targetId || !running || !steerable || stopped) return false;
      pending.push({ id, text }); return true;
    },
    durableConsume(hook: (ids: readonly number[]) => Promise<void>): void { consume = hook; },
    async roundAsync(): Promise<string | null> {
      if (stopped) return null;
      const claimed = pending.slice();
      if (claimed.length && consume) await consume(claimed.map(note => note.id));
      if (stopped) return null;
      for (const note of claimed) { heard.push(note.text); absorbed.add(note.id); }
      pending.splice(0, claimed.length);
      return heard.length === 0 ? '' : `\n\n[While you were working, the owner added: ${heard.map(text => JSON.stringify(text)).join('; ')}. Take it into account in this answer.]`;
    },
    begin(fromOwner: boolean): void {
      running = true;
      steerable = fromOwner;
      stopped = false;
      pending = [];
      heard = [];
    },
    end(): readonly string[] {
      running = false;
      target = null;
      return heard;
    },
    heard: (): readonly string[] => heard,
    stop(): boolean {
      if (running) stopped = true;
      return running;
    },
    steer(id: number, text: string): boolean {
      const open = running && steerable && !stopped;
      if (open) pending.push({ id, text });
      return open;
    },
    // Called before each model round: null means stop, otherwise the owner's additions so far.
    round(): string | null {
      if (stopped) return null;
      for (const note of pending) {
        heard.push(note.text);
        absorbed.add(note.id);
      }
      pending = [];
      return heard.length === 0 ? '' : `\n\n[While you were working, the owner added: ${heard.map((text) => `"${text}"`).join('; ')}. Take it into account in this answer.]`;
    },
    absorbed(id: number): boolean {
      return absorbed.delete(id);
    },
  };
};
export type TurnControl = ReturnType<typeof turnControl>;
