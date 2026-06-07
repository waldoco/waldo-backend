import { describe, expect, it } from "vitest";
import { parseLocalAuthStub } from "./auth";
import { type Env } from "./env";
import { handleRequest } from "./worker";

const env: Env = {
  ENVIRONMENT: "local",
  SUPABASE_URL: "https://gororukpipahvpvsydwz.supabase.co",
  WALDO_WORKER_URL: ""
};

const userId = "00000000-0000-0000-0000-000000000001";

type WaldoAgentTestBinding = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
};

function createWaldoAgentBinding(response: Response) {
  const routedNames: string[] = [];
  const forwardedRequests: Request[] = [];
  const durableObjectId: DurableObjectId = {
    name: userId,
    toString: () => userId,
    equals: (other) => other.name === userId
  };

  const binding: WaldoAgentTestBinding = {
    idFromName(name) {
      routedNames.push(name);
      return durableObjectId;
    },
    get(id) {
      expect(id).toBe(durableObjectId);

      return {
        fetch: async (request) => {
          forwardedRequests.push(request);
          return response;
        }
      };
    }
  };

  return { binding, forwardedRequests, routedNames };
}

describe("waldo-worker", () => {
  it("returns health status", async () => {
    const response = await handleRequest(new Request("https://worker.test/health"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "waldo-worker",
      environment: "local",
      supabaseUrlConfigured: true,
      waldoWorkerUrlConfigured: false
    });
  });

  it("returns 405 for unsupported health methods", async () => {
    const response = await handleRequest(new Request("https://worker.test/health", { method: "POST" }), env);

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    await expect(response.json()).resolves.toEqual({ error: "method_not_allowed" });
  });

  it("returns 500 when required runtime config is missing", async () => {
    const response = await handleRequest(new Request("https://worker.test/health"), { ENVIRONMENT: "local" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "misconfigured" });
  });

  it("returns 500 when service-role is bound to the Worker", async () => {
    const response = await handleRequest(new Request("https://worker.test/health"), {
      ...env,
      SUPABASE_SERVICE_ROLE_KEY: "should-not-be-bound"
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "misconfigured" });
  });

  it("returns 404 for unknown routes", async () => {
    const response = await handleRequest(new Request("https://worker.test/missing"), env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("rejects runtime triggers before touching the user Durable Object when auth is missing", async () => {
    const agent = createWaldoAgentBinding(Response.json({ status: "queued" }));
    const request = new Request("https://worker.test/runtime/trigger", {
      method: "POST",
      body: JSON.stringify({ trigger: "brief", traceId: "trace-1", triggeredAt: "2026-06-07T00:00:00.000Z" })
    });

    const response = await handleRequest(request, { ...env, WALDO_AGENT: agent.binding });

    expect(response.status).toBe(401);
    expect(agent.routedNames).toEqual([]);
    expect(agent.forwardedRequests).toEqual([]);
    await expect(response.json()).resolves.toEqual({ error: "auth_failed" });
  });

  it("routes authenticated runtime triggers to the authenticated user's Durable Object", async () => {
    const agent = createWaldoAgentBinding(
      Response.json({ status: "queued", userId, trigger: "brief", traceId: "trace-1" })
    );
    const request = new Request("https://worker.test/runtime/trigger", {
      method: "POST",
      headers: { Authorization: `Bearer local-user:${userId}` },
      body: JSON.stringify({
        userId: "11111111-1111-1111-1111-111111111111",
        trigger: "brief",
        traceId: "trace-1",
        triggeredAt: "2026-06-07T00:00:00.000Z"
      })
    });

    const response = await handleRequest(request, { ...env, WALDO_AGENT: agent.binding });

    expect(response.status).toBe(200);
    expect(agent.routedNames).toEqual([userId]);
    expect(agent.forwardedRequests).toHaveLength(1);
    expect(agent.forwardedRequests[0]?.headers.get("X-Waldo-User-Id")).toBe(userId);
    await expect(response.json()).resolves.toEqual({ status: "queued", userId, trigger: "brief", traceId: "trace-1" });
  });

  it("parses the local auth stub format", () => {
    const request = new Request("https://worker.test/run", {
      headers: { Authorization: `Bearer local-user:${userId}` }
    });

    expect(parseLocalAuthStub(request, env)).toEqual({ userId });
  });

  it("rejects missing auth in the local auth stub", () => {
    const request = new Request("https://worker.test/run");

    expect(parseLocalAuthStub(request, env)).toBeNull();
  });

  it("rejects empty local auth stub user ids", () => {
    const request = new Request("https://worker.test/run", {
      headers: { Authorization: "Bearer local-user:   " }
    });

    expect(parseLocalAuthStub(request, env)).toBeNull();
  });

  it("rejects non-uuid local auth stub user ids", () => {
    const request = new Request("https://worker.test/run", {
      headers: { Authorization: "Bearer local-user:user_123" }
    });

    expect(parseLocalAuthStub(request, env)).toBeNull();
  });

  it("rejects wrong auth schemes in the local auth stub", () => {
    const request = new Request("https://worker.test/run", {
      headers: { Authorization: `Basic local-user:${userId}` }
    });

    expect(parseLocalAuthStub(request, env)).toBeNull();
  });

  it("disables the local auth stub outside local env", () => {
    const request = new Request("https://worker.test/run", {
      headers: { Authorization: `Bearer local-user:${userId}` }
    });

    expect(parseLocalAuthStub(request, { ENVIRONMENT: "staging" })).toBeNull();
  });
});
