export type OverviewV1 = Readonly<{
  version: 1;
  as_of: string;
  timezone: string;
  brief: Readonly<{ status: 'sent_recorded' | 'not_sent' | 'not_scheduled'; at: string | null }>;
  waiting: Readonly<{ count: number; first: Readonly<{ id: string; summary: string }> | null }>;
  next_card: Readonly<{ id: string; label: string; scheduled_at: string }> | null;
  latest_activity: Readonly<{ kind: string; status: string; at: string; summary: string | null }> | null;
  services: readonly Readonly<{ account_id: string; email: string; grants: readonly ('calendar' | 'gmail' | 'tasks')[]; health: 'access_granted' | 'needs_reconnect' }>[];
}>;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const optional = (value: unknown): value is string | null => value === null || string(value);
const time = (value: unknown): value is string => string(value) && !Number.isNaN(Date.parse(value));
export const readOverview = (value: unknown): OverviewV1 => {
  if (!object(value) || value.version !== 1 || !time(value.as_of) || !string(value.timezone) || !object(value.brief) ||
      !['sent_recorded', 'not_sent', 'not_scheduled'].includes(String(value.brief.status)) || !optional(value.brief.at) ||
      !object(value.waiting) || !Number.isSafeInteger(value.waiting.count) || (value.waiting.count as number) < 0 ||
      (value.waiting.first !== null && (!object(value.waiting.first) || !string(value.waiting.first.id) || !string(value.waiting.first.summary))) ||
      (value.next_card !== null && (!object(value.next_card) || !string(value.next_card.id) || !string(value.next_card.label) || !time(value.next_card.scheduled_at))) ||
      (value.latest_activity !== null && (!object(value.latest_activity) || !string(value.latest_activity.kind) || !string(value.latest_activity.status) || !time(value.latest_activity.at) || !optional(value.latest_activity.summary))) ||
      !Array.isArray(value.services) || !value.services.every((item: unknown) => object(item) && string(item.account_id) && string(item.email) &&
        (item.health === 'access_granted' || item.health === 'needs_reconnect') && Array.isArray(item.grants) &&
        item.grants.every((grant: unknown) => ['calendar', 'gmail', 'tasks'].includes(String(grant))))) {
    throw new Error('The dashboard received an unsupported data shape.');
  }
  // No unvalidated extension fields (including secrets) are rendered or retained.
  return {
    version: 1, as_of: value.as_of, timezone: value.timezone,
    brief: { status: value.brief.status as OverviewV1['brief']['status'], at: value.brief.at as string | null },
    waiting: { count: value.waiting.count as number, first: value.waiting.first === null ? null : { id: (value.waiting.first as Record<string, unknown>).id as string, summary: (value.waiting.first as Record<string, unknown>).summary as string } },
    next_card: value.next_card === null ? null : { id: (value.next_card as Record<string, unknown>).id as string, label: (value.next_card as Record<string, unknown>).label as string, scheduled_at: (value.next_card as Record<string, unknown>).scheduled_at as string },
    latest_activity: value.latest_activity === null ? null : { kind: (value.latest_activity as Record<string, unknown>).kind as string, status: (value.latest_activity as Record<string, unknown>).status as string, at: (value.latest_activity as Record<string, unknown>).at as string, summary: (value.latest_activity as Record<string, unknown>).summary as string | null },
    services: value.services.map((item: Record<string, unknown>) => ({ account_id: item.account_id as string, email: item.email as string, health: item.health as 'access_granted' | 'needs_reconnect', grants: item.grants as OverviewV1['services'][number]['grants'] })),
  };
};

export const OVERVIEW_URL = '/console/dashboard/api/v1/overview';
export async function fetchOverview(signal?: AbortSignal): Promise<OverviewV1> {
  const response = await fetch(OVERVIEW_URL, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store', signal });
  if (response.status === 401) throw new Error('Sign in to see your dashboard.');
  if (!response.ok) throw new Error('The dashboard could not load right now.');
  return readOverview(await response.json() as unknown);
}
