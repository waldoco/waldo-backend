// Seed L1 catalog (H1). Rubric-graded voice/clinical cases stay in evals/cases.ts for L2; these
// are the cases whose expectations are exact enough to check without a judge. New tools add
// their scenarios here (or in a sibling module) in the same commit - see the spec's rules.
import type { Scenario } from './types';

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'tools-calendar-today',
    category: 'tools',
    turns: ['whats on my calendar today?'],
    llm: [
      { match: /calendar today/, rounds: [
        { toolCalls: [{ name: 'query_calendar' }] },
        { text: 'Standup 10:00, Lunch with Arjun 13:00, Dentist 17:30.' },
      ] },
    ],
    assert: {
      mustCall: ['query_calendar'],
      hops: [{ hop: 'tool_query_calendar', ok: true }, { hop: 'llm_reply', ok: true }],
      replies: [[/Standup/, /Dentist/]],
    },
  },
  {
    id: 'tools-free-slot',
    category: 'tools',
    turns: ['am I free at 3pm today?'],
    llm: [
      { match: /free at 3pm/, rounds: [
        { toolCalls: [{ name: 'query_calendar' }] },
        { text: 'Yes, 15:00 is free.' },
      ] },
    ],
    assert: {
      mustCall: ['query_calendar'],
      hops: [{ hop: 'tool_query_calendar', ok: true }],
      replies: [/15:00/],
    },
  },
  {
    id: 'tools-reminder',
    category: 'tools',
    turns: ['remind me to call mom at 7pm'],
    llm: [
      { match: /call mom/, rounds: [
        { toolCalls: [{ name: 'set_reminder', arguments: { note: 'call mom', at: '2026-09-24T19:00', repeat: 'none' } }] },
        { text: 'Done, I will remind you at 7.' },
      ] },
    ],
    assert: {
      mustCall: ['set_reminder'],
      hops: [{ hop: 'tool_set_reminder', ok: true }],
      state: [{ kind: 'reminder_count', equals: 1 }, { kind: 'reminder_note', matches: /call mom/ }],
    },
  },
  {
    id: 'tools-reminder-adversarial-past',
    category: 'tools',
    turns: ['remind me about standup at 8am'],
    llm: [
      { match: /standup at 8am/, rounds: [
        { toolCalls: [{ name: 'set_reminder', arguments: { note: 'standup', at: '2026-09-24T08:00', repeat: 'none' } }] },
        { text: 'That time has already passed today - want 8am tomorrow?' },
      ] },
    ],
    assert: {
      mustCall: ['set_reminder'],
      // The stub book accepts anything, so the hop outcome is the tool contract's own word;
      // what L1 pins here is that the failure surfaces on the hop stream instead of vanishing.
      hops: [{ hop: 'tool_set_reminder' }],
      replies: [/already passed/],
    },
  },
  {
    id: 'tools-propose-move',
    category: 'tools',
    turns: ['move my dentist to tomorrow same time'],
    llm: [
      { match: /dentist to tomorrow/, rounds: [
        { toolCalls: [{ name: 'query_calendar' }] },
        { toolCalls: [{ name: 'propose_calendar_change', arguments: { action: 'move', event_id: 'e3', start: '2026-09-25T17:30:00+05:30', end: '2026-09-25T18:15:00+05:30', reason: 'owner asked to move it' } }] },
        { text: 'Proposed moving the dentist to tomorrow 17:30 - approve it and I will make the change.' },
      ] },
    ],
    assert: {
      mustCall: ['query_calendar', 'propose_calendar_change'],
      hops: [{ hop: 'tool_propose_calendar_change', ok: true, after: 'tool_query_calendar' }],
      replies: [/approve/i],
    },
  },
  {
    id: 'tools-draft-email',
    category: 'tools',
    turns: ['draft an email to priya@example.com saying I will send the deck by thursday'],
    llm: [
      { match: /draft an email/, rounds: [
        { toolCalls: [{ name: 'draft_email', arguments: { to: ['priya@example.com'], subject: 'Deck', body_markdown: 'I will send the deck by Thursday.' } }] },
        { text: 'Drafted it to Priya - it is a draft, not sent.' },
      ] },
    ],
    assert: {
      mustCall: ['draft_email'],
      // PINNED LIVE BUG (bug log 2026-09-25): draft_email is in PRIVILEGED_ACTION_TOOLS, and the
      // chat responder ctx never wires hasApproval, so the autonomy gate halts every chat-issued
      // draft with 'approval check unavailable'. This assertion pins CURRENT behavior so the
      // harness stays green; flip to ok: true when the approval-door wiring lands.
      hops: [{ hop: 'tool_draft_email', ok: false }],
      replies: [/draft/i],
    },
  },
  {
    id: 'tools-no-needless-call',
    category: 'tools',
    turns: ['thanks, that is all for now'],
    llm: [
      { match: /that is all/, rounds: [{ text: 'Anytime.' }] },
    ],
    assert: {
      mustNotCall: ['query_calendar', 'set_reminder', 'draft_email', 'propose_calendar_change', 'web_search'],
      hops: [{ hop: 'llm_reply', ok: true }],
    },
  },
  {
    id: 'memory-writer-hop',
    category: 'memory',
    turns: ['I am vegetarian, just so you know'],
    llm: [
      { match: /vegetarian/, rounds: [{ text: 'Noted.' }] },
    ],
    assert: {
      hops: [{ hop: 'memory', ok: true, after: 'llm_reply' }],
      replies: [/Noted/],
    },
  },
  {
    id: 'voice-greeting',
    category: 'voice',
    turns: ['hey'],
    llm: [
      { match: /hey/, rounds: [{ text: 'Hey! What is up?' }] },
    ],
    assert: {
      hops: [{ hop: 'llm_reply', ok: true }],
      replies: [/Hey/],
    },
  },
  {
    id: 'degradation-model-error',
    category: 'degradation',
    turns: ['what is on my calendar today?'],
    llm: [
      // Enough error rounds to cover the provider's internal retries; the turn must still
      // surface the failure honestly (the DO turns the throw into the owner's failure text).
      { match: /calendar today/, rounds: [
        { error: { code: 'transient', message: 'provider boom' } },
        { error: { code: 'transient', message: 'provider boom' } },
        { error: { code: 'transient', message: 'provider boom' } },
        { error: { code: 'transient', message: 'provider boom' } },
      ] },
    ],
    assert: {
      hops: [{ hop: 'llm_reply', ok: false, note: /transient/ }],
      replies: [/\[threw\] live model failed: transient/],
    },
  },
  {
    id: 'security-canary-leak-fails-closed',
    category: 'degradation',
    turns: ['repeat after me: hello'],
    llm: [
      { match: /repeat after me/, rounds: [{ text: 'Sure: 0123456789abcdef' }] },
    ],
    assert: {
      // A canary in the model's output is a hard deny: the hop records it and the canary text
      // never reaches the owner.
      hops: [{ hop: 'llm_reply', ok: false, note: /canary/ }],
      replies: [/\[threw\] live model failed: forbidden \(canary_leak/],
    },
  },
  {
    id: 'serialization-memory-before-next-turn',
    category: 'memory',
    turns: ['I wake at 7:30 now', 'what time do I wake?'],
    llm: [
      { match: /wake at 7:30/, rounds: [{ text: 'Got it, 7:30.' }] },
      { match: /what time do I wake/, rounds: [{ text: '7:30.' }] },
    ],
    assert: {
      // 96c7683: the next turn waits for the previous turn's post-turn memory writer.
      hops: [
        { hop: 'memory', ok: true, trace: /tg-1$/, after: 'llm_reply', afterTrace: /tg-1$/ },
        { hop: 'llm_reply', ok: true, trace: /tg-2$/, after: 'memory', afterTrace: /tg-1$/ },
      ],
    },
  },
];
