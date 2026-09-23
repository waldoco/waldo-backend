import type { ConsoleView } from '../../src/channels/console';

const iso = (d: string) => `2026-09-${d}T00:00:00Z`;
const spot = (id: number, kind: string, text: string, source: 'stated' | 'inferred', evidence: string, seen: number, last: string, status = 'active') =>
  ({ id, kind, text, source, evidence, status, created_at: iso('20'), last_seen_at: iso(last), seen_count: seen });
const step = (name: string, at: string | null, note: string | null = null, state: 'ok' | 'failed' | 'unseen' = at ? 'ok' : 'unseen') => ({ step: name, state, at, note });

// Made-up console state for render tests and design previews. Not owner data.
export const SAMPLE_CONSOLE_VIEW: ConsoleView = {
  release: 'sample', timezone: 'Asia/Kolkata', now: '2026-09-23 23:40', sessionUntil: '2026-09-24 11:40', csrf: 'c'.repeat(64), notice: 'Spot dismissed. Waldo will stop using it.',
  google: { connected: false, email: null, connectAvailable: true },
  memory: {
    MEMORY_CORE: 'Lives in India, speaks Hinglish.\nGym usually 11am; 7:30-8pm when mornings fail.',
    MEMORY_GOALS: 'Ship the Waldo agent MVP to beta.',
    MEMORY_FOLLOWUPS: '2026-09-24: check how sleep went after the late call.',
    'intelligence-summary': 'Energy dips on days with calls after 10pm.',
  },
  spots: [
    spot(4, 'pattern', 'Sleeps badly after late calls', 'stated', 'you said on 23 Sep: "call ran till 1, slept like trash"', 3, '23'),
    spot(5, 'preference', 'Prefers the Brief before 9am', 'inferred', 'opened the Brief at 08:40 three days running', 2, '23'),
    spot(6, 'health', 'Skips lunch on heavy meeting days', 'stated', 'you said on 22 Sep', 1, '22'),
  ],
  retiredSpots: [spot(2, 'preference', 'Gym at 7am', 'inferred', 'one turn', 1, '21', 'dismissed'), spot(1, 'pattern', 'Late calls most weeks', 'stated', 'calendar', 4, '22', 'promoted')],
  nodes: [
    { id: 1, domain: 'work rhythm', label: 'Late calls', summary: 'Calls after 10pm, 2-3 times a week', strength: 0.7, status: 'active', first_seen: iso('21'), last_confirmed: iso('23'), supporting_spots: '[1]' },
    { id: 2, domain: 'sleep', label: 'Short sleep', summary: 'Under 6 hours on those nights', strength: 0.6, status: 'active', first_seen: iso('21'), last_confirmed: iso('23'), supporting_spots: '[4]' },
    { id: 3, domain: 'energy', label: 'Slow mornings', summary: 'Low energy before noon', strength: 0.35, status: 'stale', first_seen: iso('20'), last_confirmed: iso('20'), supporting_spots: '[]' },
  ],
  edges: [{ from_id: 1, to_id: 2, relation: 'tends to precede', strength: 0.55, evidence_count: 3 }, { from_id: 2, to_id: 3, relation: 'worsens', strength: 0.4, evidence_count: 2 }],
  cards: [
    { id: 'card:brief', name: 'The Brief', defaultTime: '08:00', time: '08:30', reason: 'gym at 11, first call at 10', sent: true, pin: null },
    { id: 'card:midday', name: 'Afternoon check-in', defaultTime: '14:00', time: '14:00', reason: 'default time', sent: true, pin: null },
    { id: 'card:close', name: 'The Close', defaultTime: '21:30', time: '22:15', reason: 'pinned by you', sent: false, pin: '22:15' },
  ],
  ledger: 'Open approvals: none\nDone: reminder "drink water" set (daily 09:00)\nReminders:\n- 2026-09-24T09:00 drink water (daily)',
  steps: [
    step('Chat reply', '2026-09-23 22:40'), step('Memory update', '2026-09-23 22:40', 'MEMORY_CORE'), step('Spots update', '2026-09-23 22:40', '+1 seen1 dismissed0 forgot0'),
    step('Reminder fired', '2026-09-23 22:45'), step('Day plan', '2026-09-23 03:00'), step('Brief / midday / close card', '2026-09-23 14:00', 'card:midday'),
    step('Fetch update card', null), step('Pre-event brief', '2026-09-23 09:50', 'google not connected', 'failed'), step('Nightly memory', '2026-09-23 03:00', '12 turns; MEMORY_CORE'),
    step('Constellation promotion', '2026-09-23 03:00', 'nodes2 edges1 promoted1'),
  ],
  trace: [
    { time: '22:40', trace: 'tg-812', hop: 'llm_reply', ok: true, ms: 2140, note: '' },
    { time: '22:40', trace: 'tg-812', hop: 'memory', ok: true, ms: 1320, note: 'MEMORY_CORE' },
    { time: '22:40', trace: 'tg-812', hop: 'spots', ok: true, ms: 1180, note: '+1 seen1 dismissed0 forgot0' },
    { time: '22:45', trace: 'r-3a1', hop: 'reminder', ok: true, ms: 1900, note: '' },
    { time: '23:38', trace: 'console:1', hop: 'console_action', ok: true, ms: 0, note: 'spot.dismiss 2' },
  ],
};
