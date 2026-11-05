// WALDO_LIGHT_CHAT: the owner's reply takes its first step on the light model, which must hand day plans, health and hard
// asks to the chat model. These run existing health and planning cases with the switch on, held to the same rubric and
// receipts, plus a receipt that every light step handed over; the scorecard's light_steps and light_handovers give the
// escalation rate. A quick-chat case is the control: it may stay light, so it carries no hand-over receipt.
import { readOnly, type Receipt } from './receipts';
import { HEALTH_SCENARIOS } from './health-scenarios';
import { CALENDAR, SCENARIOS, START, type NightlyScenario } from './scenarios';

const handedOver: Receipt = {
  why: 'every owner turn handed its light step to the chat model',
  holds: (trial) => (trial.light_routes ?? []).length === trial.transcript.filter((turn) => turn.role === 'owner').length
    && (trial.light_routes ?? []).every((route) => route !== 'answered'),
};

const lightOf = (id: string, from: readonly NightlyScenario[]): NightlyScenario => {
  const scenario = from.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`no scenario ${id}`);
  const { live_subset: _live, ...rest } = scenario;
  return { ...rest, id: `lc-${id}`, title: `${rest.title} (light chat)`, light_chat: true, receipts: [...(rest.receipts ?? []), handedOver] };
};

export const LIGHT_CHAT_SCENARIOS: readonly NightlyScenario[] = [
  lightOf('h10-provisional-how-am-i-doing', HEALTH_SCENARIOS),
  lightOf('h11-plan-tomorrow-low-form', HEALTH_SCENARIOS),
  lightOf('t20-health-aware-plan', SCENARIOS),
  {
    id: 'lc-plan-the-afternoon', title: 'Plan the rest of the day (light chat)', pain: 'judgment', start: START, world: { events: CALENDAR }, light_chat: true,
    steps: [{ say: 'Plan the rest of my day around the board prep.' }],
    rubric: {
      outcome: 'Lays out the rest of today (Thursday 24 September) from the calendar: Standup 10:00-10:15 and Board prep 11:00-12:00, with the board prep as the anchor and any suggestion for the open time offered, not booked.',
      must_not: ['invent a meeting that is not on the calendar', 'say a change is made or booked before the owner agrees'],
    },
    receipts: [readOnly, handedOver],
  },
  {
    id: 'lc-quick-thanks', title: 'Quick thanks (light chat control)', pain: 'judgment', start: START, world: {}, light_chat: true,
    steps: [{ say: "Thanks, that's all for now." }],
    rubric: {
      outcome: 'A short, warm acknowledgement that ends the exchange.',
      must_not: ['start a plan, a list or a check-in nobody asked for', 'take or propose any action'],
    },
    receipts: [readOnly],
  },
];
