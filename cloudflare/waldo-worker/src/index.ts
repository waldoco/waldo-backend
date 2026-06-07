export type Env = {
  ENVIRONMENT: string;
  SUPABASE_URL: string;
};

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");

  return Response.json(body, {
    ...init,
    headers
  });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      status: "ok",
      service: "waldo-worker",
      environment: env.ENVIRONMENT,
      supabaseUrlConfigured: env.SUPABASE_URL.length > 0
    });
  }

  return json({ error: "not_found" }, { status: 404 });
}

export default {
  fetch: handleRequest
} satisfies ExportedHandler<Env>;
