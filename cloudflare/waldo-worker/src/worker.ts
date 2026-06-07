import { parseLocalAuthStub } from "./auth";
import { type Env, readRuntimeConfig } from "./env";
import { WALDO_USER_HEADER } from "./waldo-agent-core";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/runtime/trigger") {
    return routeTriggerToUserDo(request, env);
  }

  if (url.pathname === "/health") {
    if (request.method !== "GET") {
      return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET" } });
    }

    const config = readRuntimeConfig(env);

    if (!config) {
      return Response.json({ error: "misconfigured" }, { status: 500 });
    }

    return Response.json({
      status: "ok",
      service: "waldo-worker",
      environment: config.environment,
      supabaseUrlConfigured: true,
      waldoWorkerUrlConfigured: config.waldoWorkerUrl !== undefined
    });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

export async function routeTriggerToUserDo(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const auth = parseLocalAuthStub(request, env);

  if (!auth) {
    return Response.json({ error: "auth_failed" }, { status: 401 });
  }

  if (!readRuntimeConfig(env) || !env.WALDO_AGENT) {
    return Response.json({ error: "misconfigured" }, { status: 500 });
  }

  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set(WALDO_USER_HEADER, auth.userId);

  const id = env.WALDO_AGENT.idFromName(auth.userId);
  const stub = env.WALDO_AGENT.get(id);

  return stub.fetch(new Request(request, { headers }));
}
