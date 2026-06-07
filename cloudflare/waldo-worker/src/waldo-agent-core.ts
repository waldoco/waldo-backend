import {
  channelNameSchema,
  iso8601Schema,
  triggerTypeSchema,
  type ChannelName,
  type TriggerType
} from "@pin4sf/waldo-types";
import { isUuidUserId } from "./auth";

export const WALDO_USER_HEADER = "X-Waldo-User-Id";

const MAX_TRIGGER_BODY_BYTES = 32_768;
const MAX_TRACE_ID_LENGTH = 128;

export type AgentStorage = {
  getAlarm(): Promise<number | null>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
};

export type RuntimeChannelEvent = {
  channel: ChannelName;
  eventId: string;
  payload?: Record<string, unknown>;
};

export type RuntimeTriggerEnvelope = {
  trigger: TriggerType;
  traceId: string;
  triggeredAt: string;
  channelEvent?: RuntimeChannelEvent;
  nextWakeAt?: string;
};

export type QueuedRunResponse = {
  status: "queued";
  userId: string;
  trigger: TriggerType;
  traceId: string;
  alarmChanged: boolean;
  nextWakeAt?: string;
};

export type TickDueRunsResult = {
  status: "idle";
};

type ParsedJson = { kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "oversize" };

type WaldoAgentCoreOptions = {
  now?: () => Date;
  tickDueRuns?: () => Promise<TickDueRunsResult>;
};

export class WaldoAgentCore {
  private readonly now: () => Date;
  private readonly tickDueRuns: () => Promise<TickDueRunsResult>;

  constructor(
    private readonly storage: AgentStorage,
    options: WaldoAgentCoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.tickDueRuns = options.tickDueRuns ?? tickDueRuns;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
    }

    const userId = readTrustedUserId(request);

    if (!userId) {
      return Response.json({ error: "auth_failed" }, { status: 401 });
    }

    const parsedBody = await readJsonBody(request);

    if (parsedBody.kind === "oversize") {
      return Response.json({ error: "oversize" }, { status: 413 });
    }

    if (parsedBody.kind === "invalid") {
      return Response.json({ error: "invalid_trigger_envelope" }, { status: 400 });
    }

    const envelope = parseRuntimeTriggerEnvelope(parsedBody.value);

    if (!envelope) {
      return Response.json({ error: "invalid_trigger_envelope" }, { status: 400 });
    }

    const alarmChanged = envelope.nextWakeAt ? await this.scheduleNextWake(userId, envelope.nextWakeAt) : false;
    const response: QueuedRunResponse = {
      status: "queued",
      userId,
      trigger: envelope.trigger,
      traceId: envelope.traceId,
      alarmChanged,
      ...(envelope.nextWakeAt ? { nextWakeAt: envelope.nextWakeAt } : {})
    };

    return Response.json(response);
  }

  async alarm(): Promise<TickDueRunsResult> {
    const at = this.now().toISOString();

    await this.storage.put("session_trust", { trusted: false, resetAt: at, reason: "alarm_wake" });
    await this.storage.put("last_alarm_trace", { type: "alarm_wake", at });

    return this.tickDueRuns();
  }

  async scheduleNextWake(userId: string, nextWakeAt: string): Promise<boolean> {
    if (!isUuidUserId(userId) || !isIsoTimestamp(nextWakeAt)) {
      return false;
    }

    const scheduledAt = Date.parse(nextWakeAt);
    const currentAlarm = await this.storage.getAlarm();

    if (currentAlarm === scheduledAt) {
      return false;
    }

    await this.storage.setAlarm(scheduledAt);

    return true;
  }
}

export async function tickDueRuns(): Promise<TickDueRunsResult> {
  return { status: "idle" };
}

function readTrustedUserId(request: Request): string | null {
  const userId = request.headers.get(WALDO_USER_HEADER)?.trim();

  return userId && isUuidUserId(userId) ? userId : null;
}

async function readJsonBody(request: Request): Promise<ParsedJson> {
  const text = await readBodyText(request);

  if (text === null) {
    return { kind: "oversize" };
  }

  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

async function readBodyText(request: Request): Promise<string | null> {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;

    if (size > MAX_TRIGGER_BODY_BYTES) {
      return null;
    }

    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function parseRuntimeTriggerEnvelope(value: unknown): RuntimeTriggerEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }

  const trigger = triggerTypeSchema.safeParse(value.trigger);
  const traceId = parseBoundedString(value.traceId, MAX_TRACE_ID_LENGTH);
  const triggeredAt = parseIsoTimestamp(value.triggeredAt);
  const channelEvent = parseRuntimeChannelEvent(value.channelEvent);
  const nextWakeAt = value.nextWakeAt === undefined ? undefined : parseIsoTimestamp(value.nextWakeAt);

  if (!trigger.success || !traceId || !triggeredAt || channelEvent === null || nextWakeAt === null) {
    return null;
  }

  return {
    trigger: trigger.data,
    traceId,
    triggeredAt,
    ...(channelEvent ? { channelEvent } : {}),
    ...(nextWakeAt ? { nextWakeAt } : {})
  };
}

function parseRuntimeChannelEvent(value: unknown): RuntimeChannelEvent | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return null;
  }

  const channel = channelNameSchema.safeParse(value.channel);
  const eventId = parseBoundedString(value.eventId, MAX_TRACE_ID_LENGTH);
  const payload = value.payload;

  if (!channel.success || !eventId || (payload !== undefined && !isRecord(payload))) {
    return null;
  }

  return {
    channel: channel.data,
    eventId,
    ...(payload ? { payload } : {})
  };
}

function parseBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function parseIsoTimestamp(value: unknown): string | null {
  const timestamp = parseBoundedString(value, 64);

  return timestamp && iso8601Schema.safeParse(timestamp).success ? timestamp : null;
}

function isIsoTimestamp(value: string): boolean {
  return iso8601Schema.safeParse(value).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
