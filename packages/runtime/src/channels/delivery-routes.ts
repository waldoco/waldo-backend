import { FinalNotSent, type FinalPayload, type FinalRecord } from './telegram-final-outbox';

// One surface the delivery outbox sends to: the records addressed to it, and how each is checked, held and sent there.
export type OutboxRoute = Readonly<{
  addressed(record: FinalRecord): boolean;
  allowed(record: FinalRecord): Promise<boolean>;
  defer(record: FinalRecord): Promise<number | null>;
  send(payload: FinalPayload): Promise<unknown>;
}>;

// A record is addressed to a surface's owner when both its chat and its owner subject are that owner's.
export const addressedTo = (owner: number) => (record: FinalRecord): boolean => record.payload.chat_id === owner && record.ownerSubject === String(owner);

// Takes each record to the surface it is addressed to. A record no surface claims is never allowed, so the outbox blocks it
// instead of sending it anywhere else.
export const routedDelivery = (routes: readonly OutboxRoute[]) => {
  const routeOf = (record: FinalRecord) => routes.find(route => route.addressed(record));
  return {
    allowed: async (record: FinalRecord) => (await routeOf(record)?.allowed(record)) ?? false,
    defer: async (record: FinalRecord) => (await routeOf(record)?.defer(record)) ?? null,
    send: async (payload: FinalPayload, record: FinalRecord) => {
      const route = routeOf(record);
      if (!route) throw new Error('no delivery route for this record');
      return route.send(payload);
    },
  };
};

export type Admission = 'admitted' | 'dormant' | 'retry';

// A route whose records go out only while the owner is admitted, on top of the route's own checks: an outage holds a record
// until `retryAt`, and any other refusal blocks it. One route asks once, so a drain pass asks the directory once and reports
// a refusal once.
export const admittedRoute = (route: OutboxRoute, admission: () => Promise<Admission>, retryAt: () => number, refused: (kind: Exclude<Admission, 'admitted'>) => void): OutboxRoute => {
  let asked: Promise<Admission> | undefined;
  const current = () => asked ??= admission().then(kind => { if (kind !== 'admitted') refused(kind); return kind; });
  return { ...route,
    defer: async record => (await current()) === 'retry' ? retryAt() : route.defer(record),
    allowed: async record => (await current()) === 'admitted' && route.allowed(record),
  };
};

// The send for a record addressed to the app. It fails closed: with no app delivery set it never reports a send. A failure the
// caller knows came before anything was written (`unwritten`) is not sent, so the record comes due again; any other failure
// stays as it was, and the outbox leaves it uncertain.
export const appRecordSend = (send: (payload: FinalPayload) => Promise<unknown>, delivery: () => unknown, unwritten: (error: unknown) => boolean) =>
  async (payload: FinalPayload): Promise<unknown> => {
    if (!delivery()) throw new FinalNotSent('no app delivery is set');
    try { return await send(payload); } catch (error) { throw unwritten(error) ? new FinalNotSent('the app delivery refused before writing', { cause: error }) : error; }
  };

// For an owner on both surfaces, every job that messages the owner runs on the app's runtime. Nightly sends nothing and stays.
export const appFirstExecutors = <Own extends Readonly<{ reminder: unknown; heartbeat: unknown; dreaming: unknown; pre_activity_spot: unknown; brief: unknown; standing_order: unknown }>>(own: Own,
  app: Readonly<{ fire: Own['reminder']; beat: Own['heartbeat']; briefs: Own['pre_activity_spot']; cards: Own['brief']; fireOrder: Own['standing_order'] }>): Own =>
  ({ ...own, reminder: app.fire, heartbeat: app.beat, pre_activity_spot: app.briefs, brief: app.cards, standing_order: app.fireOrder });

// Delivers a message, then sends a plain copy of its text. The copy goes once, only after the delivery succeeded, and a
// refused copy (the send returns nothing) or a failed one is only reported by its code: it never fails or repeats the delivery.
export const withPlainCopy = (deliver: (text: string) => Promise<void>, copy: (text: string) => Promise<unknown>, report: (code: 'copy_blocked' | 'copy_failed') => void) =>
  async (text: string): Promise<void> => {
    await deliver(text);
    let code: 'copy_blocked' | 'copy_failed' | null = null;
    try { if ((await copy(text)) === undefined) code = 'copy_blocked'; } catch { code = 'copy_failed'; }
    if (code) report(code);
  };
