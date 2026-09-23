import {
  briefVariantSchema,
  scheduleKindSchema,
  triggerTypeSchema,
  type BriefVariant,
  type ScheduleKind,
  type TriggerType,
} from '@waldo/contracts';

export type TriageAcceptReason =
  | 'alarm_brief'
  | 'alarm_pre_activity_spot'
  | 'alarm_pre_brief_sweep'
  | 'alarm_patrol'
  | 'alarm_dreaming'
  | 'alarm_resumed_run'
  | 'webhook_user_message'
  | 'app_user_message'
  | 'direct_user_message'
  | 'healthkit_acute'
  | 'healthkit_routine';

export type TriageRejectReason =
  | 'malformed_event'
  | 'unauthenticated_event'
  | 'unknown_event_kind'
  | 'unknown_alarm_name'
  | 'unknown_webhook'
  | 'unknown_app_event'
  | 'unknown_healthkit_delivery'
  | 'resume_requires_existing_trigger';

export type TriageDecision =
  | {
      ok: true;
      trigger: TriggerType;
      variant?: BriefVariant;
      reason: TriageAcceptReason;
    }
  | {
      ok: false;
      reason: TriageRejectReason;
      error: string;
    };

export type TriageEvent =
  | {
      kind: 'alarm';
      alarmName: string;
      scheduleKind?: ScheduleKind;
      resumedTrigger?: TriggerType;
    }
  | {
      kind: 'webhook';
      source: 'telegram' | 'app';
      intent: 'user_message';
      authenticated: true;
    }
  | {
      kind: 'app_event';
      event: 'user_message';
      authenticated: true;
    }
  | {
      kind: 'user_message';
      channel: 'telegram' | 'app';
      authenticated: true;
    }
  | {
      kind: 'healthkit_background_delivery';
      priority: 'acute' | 'routine';
      authenticated: true;
    };

type TriageEventRecord = TriageEvent & Readonly<Record<string, unknown>>;

export function triage(event: unknown): TriageDecision {
  if (!isRecord(event)) {
    return reject('malformed_event', 'triage event must be an object');
  }

  const knownEvent = knownTriageEvent(event);
  if (knownEvent === null) {
    return reject('unknown_event_kind', 'triage event kind is not recognized');
  }

  return triageKnownEvent(knownEvent);
}

function triageKnownEvent(event: TriageEventRecord): TriageDecision {
  switch (event.kind) {
    case 'alarm':
      return triageAlarm(event);
    case 'webhook':
      return triageWebhook(event);
    case 'app_event':
      return triageAppEvent(event);
    case 'user_message':
      return triageUserMessage(event);
    case 'healthkit_background_delivery':
      return triageHealthKitBackgroundDelivery(event);
    default:
      return assertNever(event);
  }
}

function knownTriageEvent(event: Record<string, unknown>): TriageEventRecord | null {
  switch (event.kind) {
    case 'alarm':
    case 'webhook':
    case 'app_event':
    case 'user_message':
    case 'healthkit_background_delivery':
      return event as TriageEventRecord;
    default:
      return null;
  }
}

function triageAlarm(event: Readonly<Record<string, unknown>>): TriageDecision {
  const alarmName = event.alarmName;
  if (typeof alarmName !== 'string' || alarmName.length === 0) {
    return reject('malformed_event', 'alarm wake requires an alarm name');
  }

  const scheduleKind = scheduleKindSchema.safeParse(event.scheduleKind);
  if (scheduleKind.success) {
    if (!alarmNameMatchesScheduleKind(alarmName, scheduleKind.data)) {
      return reject('unknown_alarm_name', 'alarm wake is not mapped to a trigger');
    }
    return triageScheduleKind(scheduleKind.data, event);
  }

  const namedTrigger = triggerFromAlarmName(alarmName);
  if (namedTrigger !== null) {
    return namedTrigger;
  }

  return reject('unknown_alarm_name', 'alarm wake is not mapped to a trigger');
}

function triageScheduleKind(
  scheduleKind: ScheduleKind,
  event: Readonly<Record<string, unknown>>,
): TriageDecision {
  switch (scheduleKind) {
    case 'journal':
    case 'handoff':
      return resumeExistingTrigger(event);
    case 'brief':
      return accept('brief', 'alarm_brief', variantFromAlarmName(String(event.alarmName)));
    case 'pre_activity_spot':
      return accept('pre_activity_spot', 'alarm_pre_activity_spot');
    case 'pre_brief_sweep':
      return accept('pre_brief_sweep', 'alarm_pre_brief_sweep');
    case 'patrol':
      return accept('patrol', 'alarm_patrol');
    case 'dreaming':
      return accept('dreaming_mode', 'alarm_dreaming');
    case 'reminder':
      return reject('unknown_alarm_name', 'owner reminders fire in the Telegram owner object');
    default:
      return assertNever(scheduleKind);
  }
}

function resumeExistingTrigger(event: Readonly<Record<string, unknown>>): TriageDecision {
  const trigger = triggerTypeSchema.safeParse(event.resumedTrigger);
  if (!trigger.success) {
    return reject(
      'resume_requires_existing_trigger',
      'durability alarm requires an existing run trigger',
    );
  }

  return accept(trigger.data, 'alarm_resumed_run');
}

function triageWebhook(event: Readonly<Record<string, unknown>>): TriageDecision {
  if (event.authenticated !== true) {
    return reject('unauthenticated_event', 'ingress event is not authenticated');
  }

  if (
    (event.source === 'telegram' || event.source === 'app') &&
    event.intent === 'user_message'
  ) {
    return accept('user_message', 'webhook_user_message');
  }

  return reject('unknown_webhook', 'webhook envelope is not mapped to a trigger');
}

function triageAppEvent(event: Readonly<Record<string, unknown>>): TriageDecision {
  if (event.authenticated !== true) {
    return reject('unauthenticated_event', 'ingress event is not authenticated');
  }

  if (event.event === 'user_message') {
    return accept('user_message', 'app_user_message');
  }

  return reject('unknown_app_event', 'app event envelope is not mapped to a trigger');
}

function triageUserMessage(event: Readonly<Record<string, unknown>>): TriageDecision {
  if (event.authenticated !== true) {
    return reject('unauthenticated_event', 'ingress event is not authenticated');
  }

  if (event.channel === 'telegram' || event.channel === 'app') {
    return accept('user_message', 'direct_user_message');
  }

  return reject('unknown_app_event', 'user message envelope is not mapped to a trigger');
}

function triageHealthKitBackgroundDelivery(
  event: Readonly<Record<string, unknown>>,
): TriageDecision {
  if (event.authenticated !== true) {
    return reject('unauthenticated_event', 'ingress event is not authenticated');
  }

  if (event.priority === 'acute') {
    return accept('fetch_alert', 'healthkit_acute');
  }
  if (event.priority === 'routine') {
    return accept('patrol', 'healthkit_routine');
  }

  return reject(
    'unknown_healthkit_delivery',
    'HealthKit background delivery envelope is not mapped to a trigger',
  );
}

function triggerFromAlarmName(alarmName: string): TriageDecision | null {
  if (alarmName === 'morning_wag' || alarmName.startsWith('brief:')) {
    return accept('brief', 'alarm_brief', variantFromAlarmName(alarmName));
  }
  if (
    alarmName.startsWith('pre_activity_spot:') ||
    alarmName.startsWith('pre-activity:') ||
    alarmName.startsWith('spot:')
  ) {
    return accept('pre_activity_spot', 'alarm_pre_activity_spot');
  }
  if (alarmName === 'pre_brief_sweep' || alarmName.startsWith('pre_brief_sweep:')) {
    return accept('pre_brief_sweep', 'alarm_pre_brief_sweep');
  }
  if (alarmName === 'patrol' || alarmName.startsWith('patrol:')) {
    return accept('patrol', 'alarm_patrol');
  }
  if (alarmName === 'dreaming' || alarmName.startsWith('dreaming:')) {
    return accept('dreaming_mode', 'alarm_dreaming');
  }

  return null;
}

function alarmNameMatchesScheduleKind(alarmName: string, scheduleKind: ScheduleKind): boolean {
  switch (scheduleKind) {
    case 'journal':
      return alarmName.startsWith('journal:');
    case 'handoff':
      return alarmName.startsWith('handoff:');
    case 'brief':
      return alarmName === 'morning_wag' || alarmName.startsWith('brief:');
    case 'pre_activity_spot':
      return (
        alarmName.startsWith('pre_activity_spot:') ||
        alarmName.startsWith('pre-activity:') ||
        alarmName.startsWith('spot:')
      );
    case 'pre_brief_sweep':
      return alarmName === 'pre_brief_sweep' || alarmName.startsWith('pre_brief_sweep:');
    case 'patrol':
      return alarmName === 'patrol' || alarmName.startsWith('patrol:');
    case 'dreaming':
      return alarmName === 'dreaming' || alarmName.startsWith('dreaming:');
    case 'reminder':
      return alarmName.startsWith('reminder:');
    default:
      return assertNever(scheduleKind);
  }
}

function variantFromAlarmName(alarmName: string): BriefVariant | undefined {
  if (alarmName === 'morning_wag') {
    return 'morning';
  }

  const suffix = alarmName.slice(alarmName.indexOf(':') + 1);
  const variant = briefVariantSchema.safeParse(suffix);
  return variant.success ? variant.data : undefined;
}

function accept(
  trigger: TriggerType,
  reason: TriageAcceptReason,
  variant?: BriefVariant,
): TriageDecision {
  if (variant === undefined) {
    return { ok: true, trigger, reason };
  }

  return { ok: true, trigger, variant, reason };
}

function reject(reason: TriageRejectReason, error: string): TriageDecision {
  return { ok: false, reason, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`unhandled triage variant ${String(value)}`);
}
