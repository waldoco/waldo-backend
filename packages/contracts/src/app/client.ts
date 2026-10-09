import { appCoreRoutesV1 } from './core';
import { appJsonWireBytes } from './core';
import { appRoutesV1 } from './agent';
import type { z } from 'zod';
type Route = (typeof appCoreRoutesV1)[number];
type AppResponse<P extends Route['path']> = z.infer<Extract<Route, { path: P }>['response']>;
type JsonRoute = Exclude<(typeof appRoutesV1)[number], { response_media_type: string }>;
type Method = JsonRoute['method'];
type Path<M extends Method> = Extract<JsonRoute, { method: M }>['path'];
type OperationResponse<M extends Method, P extends string> = z.infer<Extract<JsonRoute, { method: M; path: P }>['response']>;

export class AppApiError extends Error {
  constructor(readonly status: number) { super(`App request failed (${status})`); }
}
// Schemas and paths are the same source used by the serving handler and OpenAPI.
export type AppTransportV1 = (request: Readonly<{ path: string; method: 'GET' | 'POST'; body?: unknown; query?: Readonly<Record<string, string>>; headers?:Readonly<Record<string,string>>; authenticated: boolean }>) => Promise<Readonly<{ status: number; body: unknown }>>;
export const createAppClientV1 = (transport: AppTransportV1) => {
  return {
    async operation<M extends Method, P extends Path<M>>(method: M, path: P, input: Readonly<{ params?: Readonly<Record<string, string>>; query?: Readonly<Record<string, string>>; body?: unknown }> = {}): Promise<OperationResponse<M, P>> {
      const route = appRoutesV1.find(value => value.method === method && value.path === path)!;
      if ('response_media_type' in route) throw new Error('Binary downloads use an authenticated byte transport');
      const body = 'request' in route ? route.request.parse(input.body) : undefined;
      if(body!==undefined&&'max_request_bytes' in route&&appJsonWireBytes(body)>route.max_request_bytes)throw new Error('App request exceeds canonical UTF-8 byte bound');
      if ('query' in route) route.query.parse(input.query ?? {});
      const expanded = path.replace(/\{([^}]+)\}/g, (_, key: string) => {
        const value = input.params?.[key]; if (!value) throw new Error(`Missing route parameter ${key}`); return encodeURIComponent(value);
      });
      const headers='idempotency_field' in route?{'idempotency-key':String((body as Record<string,unknown>)[route.idempotency_field])}:undefined;
      const response = await transport({ path: expanded, method, body, query: input.query,headers, authenticated: !('authenticated' in route) || route.authenticated });
      if (response.status !== ('success_status' in route ? route.success_status : 200)) throw new AppApiError(response.status);
      return route.response.parse(response.body) as OperationResponse<M, P>;
    },
    async request<P extends Route['path']>(path: P, input?: unknown, query?: Readonly<Record<string, string>>): Promise<AppResponse<P>> {
      const route = appCoreRoutesV1.find(value => value.path === path)!;
      const body = 'request' in route ? route.request.parse(input) : undefined;
      if(body!==undefined&&'max_request_bytes' in route&&appJsonWireBytes(body)>route.max_request_bytes)throw new Error('App request exceeds canonical UTF-8 byte bound');
      const response = await transport({ path, method: route.method, body, query, authenticated: route.authenticated });
      if (response.status !== route.success_status) throw new AppApiError(response.status);
      return route.response.parse(response.body) as AppResponse<P>;
    },
  };
};
