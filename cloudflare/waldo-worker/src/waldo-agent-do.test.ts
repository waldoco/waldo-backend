import { describe, expect, it } from "vitest";
import { WaldoAgentCore, type AgentStorage } from "./waldo-agent-core";

const userId = "00000000-0000-0000-0000-000000000001";
const triggeredAt = "2026-06-07T00:00:00.000Z";
const nextWakeAt = "2026-06-07T00:05:00.000Z";

function createAgentStorage(initialAlarm: number | null = null) {
  const writes = new Map<string, unknown>();
  let alarm = initialAlarm;
  let setAlarmCalls = 0;

  const storage: AgentStorage = {
    getAlarm: async () => alarm,
    put: async (key, value) => {
      writes.set(key, value);
    },
    setAlarm: async (scheduledTime) => {
      alarm = scheduledTime;
      setAlarmCalls += 1;
    }
  };

  return { storage, writes, get alarm() { return alarm; }, get setAlarmCalls() { return setAlarmCalls; } };
}

describe("WaldoAgent Durable Object shell", () => {
  it("rejects malformed trigger envelopes without scheduling work", async () => {
    const store = createAgentStorage();
    const agent = new WaldoAgentCore(store.storage);

    const response = await agent.fetch(
      new Request("https://agent.test/runtime/trigger", {
        method: "POST",
        headers: { "X-Waldo-User-Id": userId },
        body: JSON.stringify({ trigger: "not-real", traceId: "trace-1", triggeredAt })
      })
    );

    expect(response.status).toBe(400);
    expect(store.alarm).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "invalid_trigger_envelope" });
  });

  it("rejects trace ids with characters unsafe for logs", async () => {
    const store = createAgentStorage();
    const agent = new WaldoAgentCore(store.storage);

    const response = await agent.fetch(
      new Request("https://agent.test/runtime/trigger", {
        method: "POST",
        headers: { "X-Waldo-User-Id": userId },
        body: JSON.stringify({ trigger: "brief", traceId: "trace\n1", triggeredAt })
      })
    );

    expect(response.status).toBe(400);
    expect(store.alarm).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "invalid_trigger_envelope" });
  });

  it("rejects channel event ids with characters unsafe for logs", async () => {
    const store = createAgentStorage();
    const agent = new WaldoAgentCore(store.storage);

    const response = await agent.fetch(
      new Request("https://agent.test/runtime/trigger", {
        method: "POST",
        headers: { "X-Waldo-User-Id": userId },
        body: JSON.stringify({
          trigger: "brief",
          traceId: "trace-1",
          triggeredAt,
          channelEvent: { channel: "telegram", eventId: "evt\t1" }
        })
      })
    );

    expect(response.status).toBe(400);
    expect(store.alarm).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "invalid_trigger_envelope" });
  });

  it("queues valid trigger envelopes without scheduling when nextWakeAt is absent", async () => {
    const store = createAgentStorage();
    const agent = new WaldoAgentCore(store.storage);

    const response = await agent.fetch(
      new Request("https://agent.test/runtime/trigger", {
        method: "POST",
        headers: { "X-Waldo-User-Id": userId },
        body: JSON.stringify({ trigger: "brief", traceId: "trace-1", triggeredAt })
      })
    );

    expect(response.status).toBe(200);
    expect(store.alarm).toBeNull();
    expect(store.setAlarmCalls).toBe(0);
    await expect(response.json()).resolves.toEqual({
      status: "queued",
      userId,
      trigger: "brief",
      traceId: "trace-1",
      alarmChanged: false
    });
  });

  it("queues valid trigger envelopes and schedules the same wake once", async () => {
    const store = createAgentStorage();
    const agent = new WaldoAgentCore(store.storage);
    const body = {
      trigger: "brief",
      traceId: "trace-1",
      triggeredAt,
      nextWakeAt,
      channelEvent: { channel: "telegram", eventId: "evt-1" }
    };

    const first = await agent.fetch(
      new Request("https://agent.test/runtime/trigger", {
        method: "POST",
        headers: { "X-Waldo-User-Id": userId },
        body: JSON.stringify(body)
      })
    );
    const second = await agent.fetch(
      new Request("https://agent.test/runtime/trigger", {
        method: "POST",
        headers: { "X-Waldo-User-Id": userId },
        body: JSON.stringify(body)
      })
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.alarm).toBe(Date.parse(nextWakeAt));
    expect(store.setAlarmCalls).toBe(1);
    await expect(first.json()).resolves.toEqual({
      status: "queued",
      userId,
      trigger: "brief",
      traceId: "trace-1",
      nextWakeAt,
      alarmChanged: true
    });
    await expect(second.json()).resolves.toEqual({
      status: "queued",
      userId,
      trigger: "brief",
      traceId: "trace-1",
      nextWakeAt,
      alarmChanged: false
    });
  });
});
