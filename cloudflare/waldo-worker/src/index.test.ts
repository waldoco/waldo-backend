import { describe, expect, it } from "vitest";
import { parseLocalAuthStub } from "./auth";
import { type Env } from "./env";
import { handleRequest } from "./index";

const env: Env = {
  ENVIRONMENT: "local",
  SUPABASE_URL: "https://gororukpipahvpvsydwz.supabase.co",
  WALDO_WORKER_URL: ""
};

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

  it("parses the local auth stub format", () => {
    const request = new Request("https://worker.test/run", {
      headers: { Authorization: "Bearer local-user:00000000-0000-0000-0000-000000000001" }
    });

    expect(parseLocalAuthStub(request, env)).toEqual({ userId: "00000000-0000-0000-0000-000000000001" });
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
      headers: { Authorization: "Basic local-user:00000000-0000-0000-0000-000000000001" }
    });

    expect(parseLocalAuthStub(request, env)).toBeNull();
  });

  it("disables the local auth stub outside local env", () => {
    const request = new Request("https://worker.test/run", {
      headers: { Authorization: "Bearer local-user:00000000-0000-0000-0000-000000000001" }
    });

    expect(parseLocalAuthStub(request, { ENVIRONMENT: "staging" })).toBeNull();
  });
});
