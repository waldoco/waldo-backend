import { appRoutesV1 } from './agent';

export class AppApiError extends Error {
  constructor(readonly status: number) { super(`App request failed (${status})`); }
}
// Schemas and paths are the same source used by the serving handler and OpenAPI.
export type AppTransportV1 = (request: Readonly<{ path: string; method: 'GET' | 'POST'; body?: unknown; query?: Readonly<Record<string, string>>; authenticated: boolean }>) => Promise<Readonly<{ status: number; body: unknown }>>;
export const createAppClientV1 = (transport: AppTransportV1) => {
  return {
    async request<P extends (typeof appRoutesV1)[number]['path']>(path: P, input?: unknown, query?: Readonly<Record<string, string>>) {
      const route = appRoutesV1.find(value => value.path === path)!;
      const body = 'request' in route ? route.request.parse(input) : undefined;
      const response = await transport({ path, method: route.method, body, query, authenticated: route.authenticated });
      if (response.status < 200 || response.status >= 300) throw new AppApiError(response.status);
      return route.response.parse(response.body);
    },
  };
};
