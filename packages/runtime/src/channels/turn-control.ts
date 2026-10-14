// Stop and steer (W6). A turn runs as rounds of model calls; between rounds the owner can stop it
// or add direction. Anything the running turn saw is absorbed, so it is not answered twice.
import type { InboundSpan, InboundView } from './owner-inbound-turn';

export const STOPPED_REPLY = 'Stopped. Nothing more on that one.';

export const turnControl = () => {
  let child: { bindTarget(id: string): void; durableConsume(hook: (ids: readonly number[]) => Promise<void>): void; steerTarget(targetId: string, id: number, steer: InboundView): boolean; stop(): boolean; steer(id: number, text: string): boolean } | undefined;
  let revision = 0;
  let running = false;
  let target: string | null = null;
  let steerable = false;
  let stopped = false;
  // A steer keeps the spans the owner did not write, so memory never takes a quote in it as their words.
  let pending: { id: number; text: string; foreignRanges: readonly InboundSpan[] }[] = [];
  let heard: InboundView[] = [];
  let leftover: typeof pending = [];
  const absorbed = new Set<number>();
  let consume: ((ids: readonly number[]) => Promise<void>) | undefined;
  return {
    route(next: NonNullable<typeof child>): void { child = next; if (target) next.bindTarget(target); if (consume) next.durableConsume(consume); },
    unroute(next: NonNullable<typeof child>): void { if (child === next) child = undefined; },
    bindTarget(id: string): void { target = id; child?.bindTarget(id); },
    steerTarget(targetId: string, id: number, steer: InboundView): boolean {
      if (child) return child.steerTarget(targetId, id, steer);
      if (target !== targetId || !running || !steerable || stopped) return false;
      pending.push({ id, ...steer }); revision++; return true;
    },
    durableConsume(hook: (ids: readonly number[]) => Promise<void>): void { consume = hook; child?.durableConsume(hook); },
    async roundAsync(): Promise<string | null> {
      if (stopped) return null;
      const capturedTarget = target;
      const claimed = pending.slice();
      if (claimed.length && consume) await consume(claimed.map(note => note.id));
      if (stopped || target !== capturedTarget) return null;
      for (const { id, ...steer } of claimed) { heard.push(steer); absorbed.add(id); }
      pending.splice(0, claimed.length);
      return heard.length === 0 ? '' : `\n\n[While you were working, the owner added: ${heard.map(steer => JSON.stringify(steer.text)).join('; ')}. Take it into account in this answer.]`;
    },
    begin(fromOwner: boolean): void {
      running = true;
      steerable = fromOwner;
      stopped = false;
      pending = [];
      leftover = [];
      heard = [];
    },
    end(): readonly InboundView[] {
      // Steers that arrived after the last round were never seen by the model; the host must answer them as their own turn.
      leftover = pending.filter(note => !absorbed.has(note.id));
      pending = [];
      running = false;
      target = null;
      return heard;
    },
    revision: () => revision,
    heard: (): readonly InboundView[] => heard,
    unconsumed: (): readonly { id: number; text: string; foreignRanges: readonly InboundSpan[] }[] => leftover,
    stop(): boolean {
      if (child) return child.stop();
      if (running) { stopped = true; revision++; }
      return running;
    },
    steer(id: number, text: string): boolean {
      if (child) return child.steer(id, text);
      const open = running && steerable && !stopped;
      if (open) { pending.push({ id, text, foreignRanges: [] }); revision++; }
      return open;
    },
    // Called before each model round: null means stop, otherwise the owner's additions so far.
    round(): string | null {
      if (stopped) return null;
      for (const { id, ...steer } of pending) {
        heard.push(steer);
        absorbed.add(id);
      }
      pending = [];
      return heard.length === 0 ? '' : `\n\n[While you were working, the owner added: ${heard.map((steer) => `"${steer.text}"`).join('; ')}. Take it into account in this answer.]`;
    },
    absorbed(id: number): boolean {
      return absorbed.delete(id);
    },
  };
};
export type TurnControl = ReturnType<typeof turnControl>;
