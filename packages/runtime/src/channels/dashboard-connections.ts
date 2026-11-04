// Narrow read projection for the dashboard connections page. Pure function over owner-DO state:
// never recycles ConsoleView (it carries CSRF, memory and other private data) and never exposes
// raw provider error text, only a closed health value. Route registration is a separate seam.
export const DASHBOARD_CONNECTIONS_PATH = '/console/dashboard/api/v1/connections';

type Grant = Readonly<{ id: string; email: string; error: string | null; calendar: boolean; mail: boolean; tasks: boolean }>;

export const dashboardConnections = (input: Readonly<{
  now: number; sessionCount: number; sessionUntil: string;
  google: Readonly<{ accounts: readonly Grant[]; connectAvailable: boolean }>;
  telegram: Readonly<{ linked: boolean; unlinkAvailable: boolean }>;
}>) => ({
  version: 1 as const,
  as_of: new Date(input.now).toISOString(),
  google: {
    connect_available: input.google.connectAvailable,
    accounts: input.google.accounts.map((grant) => ({
      account_id: grant.id, email: grant.email,
      grants: [grant.calendar ? 'calendar' as const : null, grant.mail ? 'gmail' as const : null, grant.tasks ? 'tasks' as const : null].filter((value): value is 'calendar' | 'gmail' | 'tasks' => value !== null),
      health: grant.error ? 'needs_reconnect' as const : 'access_granted' as const,
      can_reconnect: Boolean(grant.error) && input.google.connectAvailable,
    })),
  },
  telegram: { linked: input.telegram.linked, unlink_available: input.telegram.unlinkAvailable },
  sessions: { count: input.sessionCount, current_until: input.sessionUntil },
});
