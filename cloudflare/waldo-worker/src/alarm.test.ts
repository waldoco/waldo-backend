import { describe, expect, it } from "vitest";
import { WaldoAgentCore, type AgentStorage } from "./waldo-agent-core";

const now = "2026-06-07T00:00:00.000Z";

function createAgentStorage() {
  const writes = new Map<string, unknown>();

  const storage: AgentStorage = {
    getAlarm: async () => null,
    put: async (key, value) => {
      writes.set(key, value);
    },
    setAlarm: async () => undefined
  };

  return { storage, writes };
}

describe("WaldoAgent alarm resume", () => {
  it("resets session trust, records alarm wake trace, and ticks due runs", async () => {
    const store = createAgentStorage();
    const ticks: string[] = [];
    const agent = new WaldoAgentCore(store.storage, {
      now: () => new Date(now),
      tickDueRuns: async () => {
        ticks.push("tick");
        return { status: "idle" };
      }
    });

    const result = await agent.alarm();

    expect(result).toEqual({ status: "idle" });
    expect(ticks).toEqual(["tick"]);
    expect(store.writes.get("session_trust")).toEqual({ trusted: false, resetAt: now, reason: "alarm_wake" });
    expect(store.writes.get("last_alarm_trace")).toEqual({ type: "alarm_wake", at: now });
  });
});
