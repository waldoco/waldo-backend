import { z } from 'zod';

export const componentHeartbeatSchema = z.strictObject({
  ownerId: z.string().min(1),
  component: z.string().min(1),
  generation: z.int().nonnegative(),
  checkedAt: z.int().nonnegative(),
  expiresAt: z.int().nonnegative(),
  state: z.enum(['healthy', 'degraded', 'offline']),
  detail: z.string().max(500).nullable(),
});
export type ComponentHeartbeat = z.infer<typeof componentHeartbeatSchema>;

export type HeartbeatStatus = Readonly<{
  ownerId: string;
  generatedAt: number;
  overall: 'healthy' | 'degraded' | 'offline';
  components: readonly ComponentHeartbeat[];
}>;

export class HeartbeatStatusModule {
  private readonly components = new Map<string, ComponentHeartbeat>();

  put(authenticatedOwnerId: string, input: unknown): ComponentHeartbeat {
    const next = componentHeartbeatSchema.parse(input);
    if (next.ownerId !== authenticatedOwnerId) throw new Error('heartbeat owner mismatch');
    if (next.expiresAt < next.checkedAt) throw new Error('heartbeat expiry precedes check');
    const key = JSON.stringify([next.ownerId, next.component]);
    const prior = this.components.get(key);
    if (prior && (next.generation < prior.generation || next.checkedAt < prior.checkedAt)) {
      throw new Error('heartbeat stale update');
    }
    const stored = Object.freeze({ ...next });
    this.components.set(key, stored);
    return stored;
  }

  status(authenticatedOwnerId: string, generatedAt: number): HeartbeatStatus {
    const components = [...this.components.values()]
      .filter((item) => item.ownerId === authenticatedOwnerId)
      .sort((a, b) => a.component.localeCompare(b.component))
      .map((item) => item.expiresAt <= generatedAt && item.state !== 'offline'
        ? Object.freeze({ ...item, state: 'offline' as const, detail: 'heartbeat expired' })
        : item);
    const overall = components.some((item) => item.state === 'offline')
      ? 'offline'
      : components.some((item) => item.state === 'degraded') ? 'degraded' : 'healthy';
    return Object.freeze({ ownerId: authenticatedOwnerId, generatedAt, overall, components: Object.freeze(components) });
  }
}
