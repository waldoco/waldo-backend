import { describe, expect, it } from "vitest";
import { parseLocalAuthStub } from "./auth";
import { type Env, handleRequest } from "./index";

const env: Env = {
  ENVIRONMENT: "test",
  SUPABASE_URL: "https://gororukpipahvpvsydwz.supabase.co"
};

describe("waldo-worker", () => {
  it("returns health status", async () => {
    const response = await handleRequest(new Request("https://worker.test/health"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "waldo-worker",
      environment: "test",
      supabaseUrlConfigured: true
    });
  });

  it("returns 404 for unknown routes", async () => {
    const response = await handleRequest(new Request("https://worker.test/missing"), env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("parses the local auth stub format", () => {
    const request = new Request("https://worker.test/run", {
      headers: { Authorization: "Bearer local-user:user_123" }
    });

    expect(parseLocalAuthStub(request)).toEqual({ userId: "user_123" });
  });

  it("rejects missing auth in the local auth stub", () => {
    const request = new Request("https://worker.test/run");

    expect(parseLocalAuthStub(request)).toBeNull();
  });
});
