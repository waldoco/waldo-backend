import { OPENAI_GPT_5_MINI_MODEL } from '@waldo/contracts';
import type { ConsoleView } from '../../src/channels/console';

const iso = (d: string) => `2026-09-${d}T00:00:00Z`;
const spot = (id: number, kind: string, text: string, source: 'stated' | 'confirmed' | 'inferred', evidence: string, seen: number, last: string, status = 'active') =>
  ({ id, kind, text, source, evidence, origin: null, status, created_at: iso('20'), last_seen_at: iso(last), seen_count: seen });
const step = (name: string, at: string | null, note: string | null = null, state: 'ok' | 'failed' | 'unseen' = at ? 'ok' : 'unseen') => ({ step: name, state, at, note });

// Made-up console state for render tests and design previews. Not owner data.
export const SAMPLE_CONSOLE_VIEW: ConsoleView = {
  release: 'sample', timezone: 'Asia/Kolkata', now: '2026-09-23 23:40', sessionUntil: '2026-09-24 11:40', sessionCount: 1, approvals: [{id: 'p1', summary: 'Move "Gym" to Sat 27 Sep, 07:00 to 08:00. Legs day shifted.', state: 'open', undoable: false }], usage: [{ model: OPENAI_GPT_5_MINI_MODEL, calls: 12, input: 48200, cached: 12000, output: 3900, usd: 0.0231 }], csrf: 'c'.repeat(64), notice: 'Spot dismissed. Waldo will stop using it.',
  telegram: { linked: true, unlinkAvailable: true },
  google: { accounts: [], connectAvailable: true },
  profile: [
    { title: 'About you', lines: ['Lives in India, speaks Hinglish.'] },
    { title: 'Routines', lines: ['Gym usually 11am; 7:30-8pm when mornings fail.'] },
    { title: 'Goals', lines: ['Ship the Waldo agent MVP to beta.'] },
    { title: 'Follow-ups', lines: ['2026-09-24: check how sleep went after the late call.'] },
  ],
  barriers: 1,
  spots: [
    spot(4, 'pattern', 'Sleeps badly after late calls', 'stated', 'you said on 23 Sep: "call ran till 1, slept like trash"', 3, '23'),
    spot(5, 'preference', 'Prefers the Brief before 9am', 'inferred', 'opened the Brief at 08:40 three days running', 2, '23'),
    spot(6, 'health', 'Skips lunch on heavy meeting days', 'stated', 'you said on 22 Sep', 1, '22'),
  ],
  retiredSpots: [spot(2, 'preference', 'Gym at 7am', 'inferred', 'one turn', 1, '21', 'dismissed'), spot(1, 'pattern', 'Late calls most weeks', 'stated', 'calendar', 4, '22', 'promoted')],
  forgettingSpots: [spot(7, 'fact', 'Old phone number ending 4123', 'stated', 'you said on 19 Sep', 1, '19', 'purging')],
  nodes: [
    { id: 1, domain: 'work rhythm', label: 'Late calls', summary: 'Calls after 10pm, 2-3 times a week', strength: 0.7, status: 'active', first_seen: iso('21'), last_confirmed: iso('23'), supporting_spots: '[1]' },
    { id: 2, domain: 'sleep', label: 'Short sleep', summary: 'Under 6 hours on those nights', strength: 0.6, status: 'active', first_seen: iso('21'), last_confirmed: iso('23'), supporting_spots: '[4]' },
    { id: 3, domain: 'energy', label: 'Slow mornings', summary: 'Low energy before noon', strength: 0.35, status: 'stale', first_seen: iso('20'), last_confirmed: iso('20'), supporting_spots: '[]' },
  ],
  edges: [{ from_id: 1, to_id: 2, relation: 'tends to precede', strength: 0.55, evidence_count: 3 }, { from_id: 2, to_id: 3, relation: 'worsens', strength: 0.4, evidence_count: 2 }],
  cards: [
    { id: 'card:brief', name: 'The Brief', defaultTime: '08:00', time: '08:30', reason: 'gym at 11, first call at 10', sent: true, pin: null },
    { id: 'card:midday', name: 'Check-in', defaultTime: '14:00', time: '14:00', reason: 'default time', sent: true, pin: null },
    { id: 'card:close', name: 'The Close', defaultTime: '21:30', time: '22:15', reason: 'pinned by you', sent: false, pin: '22:15' },
  ],
  proactivity: { quiet_start: '23:00', quiet_end: '07:30', volume: 'normal' },
  ledger: 'Open approvals: none\nDone: reminder "drink water" set (daily 09:00)\nReminders:\n- 2026-09-24T09:00 drink water (daily)',
  files: [
    { id: 2, kind: 'document', file_id: 'f2', name: 'blood-panel-sept.pdf', mime: 'application/pdf', size: 482_000, caption: 'can you read this', at: Date.parse('2026-09-23T12:10:00Z') },
    { id: 1, kind: 'voice', file_id: 'f1', name: 'voice-note.ogg', mime: 'audio/ogg', size: 38_000, caption: '', at: Date.parse('2026-09-23T04:30:00Z') },
  ],
  steps: [
    step('Chat reply', '2026-09-23 22:40'), step('Memory update', '2026-09-23 22:40', '+1 held0 seen1 confirmed0 dismissed0 forgot0'),
    step('Reminder fired', '2026-09-23 22:45'), step('Day plan', '2026-09-23 03:00'), step('Brief / midday / close card', '2026-09-23 14:00', 'card:midday'),
    step('Fetch update card', null), step('Pre-event brief', '2026-09-23 09:50', 'google not connected', 'failed'), step('Nightly memory', '2026-09-23 03:00', '12 turns; MEMORY_CORE'),
    step('Constellation promotion', '2026-09-23 03:00', 'nodes2 edges1 promoted1'),
  ],
  trace: [
    { time: '22:40', trace: 'tg-812', hop: 'llm_reply', ok: true, ms: 2140, note: '' },
    { time: '22:40', trace: 'tg-812', hop: 'memory', ok: true, ms: 1320, note: '+1 held0 seen1 confirmed0 dismissed0 forgot0' },
    { time: '22:40', trace: 'tg-812', hop: 'spots', ok: true, ms: 1180, note: '+1 seen1 dismissed0 forgot0' },
    { time: '22:45', trace: 'r-3a1', hop: 'reminder', ok: true, ms: 1900, note: '' },
    { time: '23:38', trace: 'console:1', hop: 'console_action', ok: true, ms: 0, note: 'spot.dismiss 2' },
  ],
};
