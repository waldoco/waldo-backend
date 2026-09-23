// Stop and steer (W6). A turn runs as rounds of model calls; between rounds the owner can stop it
// or add direction. Anything the running turn saw is absorbed, so it is not answered twice.
export const STOPPED_REPLY = 'Stopped. Nothing more on that one.';

export const turnControl = () => {
  let running = false;
  let steerable = false;
  let stopped = false;
  let pending: { id: number; text: string }[] = [];
  let heard: string[] = [];
  const absorbed = new Set<number>();
  return {
    begin(fromOwner: boolean): void {
      running = true;
      steerable = fromOwner;
      stopped = false;
      pending = [];
      heard = [];
    },
    end(): readonly string[] {
      running = false;
      return heard;
    },
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
