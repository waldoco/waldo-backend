import { type Env, readRuntimeConfig } from "./env";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

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

export default {
  fetch: handleRequest
} satisfies ExportedHandler<Env>;
