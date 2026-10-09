import { z } from 'zod';
import { appControlRoutesV1 } from './controls';
import { appArtifactRoutesV1 } from './artifacts';
import { appThreadRoutesV1 } from './threads';
import { appReplayRoutesV1 } from './replay';
import { appRightsRoutesV1 } from './rights';
import { appAccessRoutesV1 } from './access';
import { appHealthRoutesV1 } from './health';

import { appCoreRoutesV1, APP_AGENT_VERSION } from './core';
export * from './core';

export const appRoutesV1 = [...appCoreRoutesV1, ...appControlRoutesV1, ...appArtifactRoutesV1, ...appThreadRoutesV1,...appReplayRoutesV1,...appRightsRoutesV1,...appAccessRoutesV1,...appHealthRoutesV1] as const;
export const buildAppOpenApiV1 = () => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of appRoutesV1) {
    const request = 'request' in route ? route.request : null;
    const response = 'response' in route ? route.response : null;
    const status = 'success_status' in route ? route.success_status : 200;
    const metadata = route as unknown as { request_media_type?: string; response_media_type?: string };
    const parameters: unknown[] = [];
    if('idempotency_field' in route)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string'},'x-waldo-body-field':route.idempotency_field});
    for (const match of route.path.matchAll(/\{([^}]+)\}/g)) parameters.push({ name: match[1], in: 'path', required: true, schema: { type: 'string' } });
    if ('query' in route) {
      const schema = z.toJSONSchema(route.query, { io: 'input' }) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, property] of Object.entries(schema.properties ?? {})) parameters.push({ name, in: 'query', required: schema.required?.includes(name) ?? false, schema: property });
    }
    (paths[route.path] ??= {})[route.method.toLowerCase()] = {
      security: !('authenticated' in route) || route.authenticated ? [{ appBearer: [] }] : [],
      'x-waldo-success-status': status,
      ...('max_request_bytes' in route ? { 'x-waldo-max-request-bytes': route.max_request_bytes } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(request ? { requestBody: { required: true, content: { [metadata.request_media_type ?? 'application/json']: { schema: metadata.request_media_type === 'multipart/form-data'
        ? { ...z.toJSONSchema(request, { io: 'input' }), properties: { ...(z.toJSONSchema(request, { io: 'input' }) as { properties: object }).properties, file: { type: 'string', format: 'binary' } }, required: ['path', 'expected_revision', 'operation_id', 'file'] }
        : z.toJSONSchema(request, { io: 'input' }) } } } } : {}),
      responses: { [String(status)]: { description: status === 202 ? 'Durable admission; execution and delivery remain separate' : 'Current owner result',
        content: { [metadata.response_media_type ?? 'application/json']: { schema: response ? z.toJSONSchema(response) : { type: 'string', contentEncoding: 'base64' } } } },
        '401': { description: 'Session expired or revoked' }, '409': { description: 'Revision or idempotency conflict' }, '503': { description: 'Unavailable or unconfirmed' } },
    };
  }
  return { openapi: '3.1.0', info: { title: 'Waldo owner app API', version: APP_AGENT_VERSION },
    components: { securitySchemes: { appBearer: { type: 'http', scheme: 'bearer' } } }, paths };
};
