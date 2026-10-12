import type { FinalPayload, FinalRecord } from './telegram-final-outbox';

// One surface the delivery outbox sends to: the records addressed to it, and how each is checked, held and sent there.
export type OutboxRoute = Readonly<{
  addressed(record: FinalRecord): boolean;
  allowed(record: FinalRecord): Promise<boolean>;
  defer(record: FinalRecord): Promise<number | null>;
  send(payload: FinalPayload): Promise<unknown>;
}>;

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
// until `retryAt`, and any other refusal blocks it. One route asks once, so a drain pass asks the directory once.
export const admittedRoute = (route: OutboxRoute, admission: () => Promise<Admission>, retryAt: () => number): OutboxRoute => {
  let asked: Promise<Admission> | undefined;
  const current = () => asked ??= admission();
  return { ...route,
    defer: async record => (await current()) === 'retry' ? retryAt() : route.defer(record),
    allowed: async record => (await current()) === 'admitted' && route.allowed(record),
  };
};
