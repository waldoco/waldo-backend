// Ask triggers: what the model is given when it has to decide whether to ask, go ahead or keep trying. The scripted
// model stands in for the live one, so these pin the input, never the judgment; the everyday-errands eval grades that.
import type { Scenario } from './types';

const REMOVED_ASKING_RULES = [
  'Ask at most one clarifying question',
  'Do not reply with only a link or a question before you have read candidates',
  'ask one narrow confirmation',
  'One suggestion per message, not a menu',
  '/stop',
  '/ledger',
];

export const ASKING_SCENARIOS: readonly Scenario[] = [
  {
    // A fact the calendar holds reaches the model, with the rule to look before asking, before it answers.
    id: 'asking-looks-before-asking',
    category: 'asking',
    turns: ['When should I leave for the airport tomorrow?'],
    llm: [
      { match: /airport tomorrow/, rounds: [
        { toolCalls: [{ name: 'query_calendar', arguments: { date_range: { from: '2026-09-25T00:00:00+05:30', to: '2026-09-26T00:00:00+05:30' } } }] },
        { text: 'Your flight leaves at 12:05, so head out by about 9:30.' },
      ] },
    ],
    fixtures: { events: [{ id: 'f1', title: 'Flight 6E 2041 Bengaluru to Delhi', start: '2026-09-25T12:05:00+05:30', end: '2026-09-25T14:50:00+05:30', all_day: false }] },
    assert: {
      modelInput: [{
        turn: 1,
        mustContain: [
          'When should I leave for the airport tomorrow?',
          'Flight 6E 2041 Bengaluru to Delhi',
          'Look before you ask: their calendars (all of them, not just the main one)',
          'Never ask for a fact you could find there.',
        ],
        mustNotContain: REMOVED_ASKING_RULES,
      }],
    },
  },
  {
    // One calendar of two fails: the failed read, the read that worked and the rule to answer from it all reach the model.
    id: 'asking-partial-answer-when-a-calendar-fails',
    category: 'asking',
    turns: ['When am I free on Friday for 30 min?'],
    llm: [
      { match: /free on Friday/, rounds: [
        { toolCalls: [{ name: 'query_availability', arguments: { date_range: { from: '2026-09-25T09:00:00+05:30', to: '2026-09-25T18:00:00+05:30' }, calendar_ids: ['primary', 'en.indian#holiday@group.v.calendar.google.com'], duration_minutes: 30 } }] },
        { toolCalls: [{ name: 'query_availability', arguments: { date_range: { from: '2026-09-25T09:00:00+05:30', to: '2026-09-25T18:00:00+05:30' }, calendar_ids: ['primary'], duration_minutes: 30 } }] },
        { text: 'Friday you are free 10:15 to 13:00 and 14:00 to 15:00, going by your main calendar. I could not read Holidays in India.' },
      ] },
    ],
    fixtures: { freeBusy: {
      primary: { busy: [{ start: '2026-09-25T09:00:00+05:30', end: '2026-09-25T10:15:00+05:30' }, { start: '2026-09-25T13:00:00+05:30', end: '2026-09-25T14:00:00+05:30' }, { start: '2026-09-25T15:00:00+05:30', end: '2026-09-25T18:00:00+05:30' }] },
      'en.indian#holiday@group.v.calendar.google.com': { busy: [], errors: [{ reason: 'notFound' }] },
    } },
    assert: {
      modelInput: [{
        turn: 1,
        mustContain: [
          'When am I free on Friday for 30 min?',
          'unavailable_calendar_ids',
          'complete_provider_coverage',
          'When one source fails and others worked (one calendar of several, one site of three), answer from what worked and name the gap; never withhold the whole answer.',
          'For free time, query again without the calendar that failed',
        ],
        mustNotContain: REMOVED_ASKING_RULES,
      }],
    },
  },
  {
    // The details the owner gave earlier reach the turn that decides whether to ask, beside the rule to use them.
    id: 'asking-stay-uses-known-details',
    category: 'asking',
    turns: [
      'Heads up: three of us are going to the Pune product summit, 22 to 24 Nov, and we want stays under 5,000 a night.',
      'Find the email with the summit venue and suggest the 3 closest hotels, with distance and price.',
    ],
    llm: [
      { match: /^Heads up: three of us/, rounds: [{ text: 'Got it.' }] },
      { match: /summit venue/, rounds: [
        { toolCalls: [{ name: 'get_communication' }] },
        { text: 'The summit is at the Hinjewadi convention centre. Before I search: 22 to 24 Nov, three of you, under 5,000 a night. One room or two?' },
      ] },
    ],
    fixtures: { mail: [{ id: 'm1', from: 'Summit desk <desk@summit.example>', subject: 'Your pass: Pune product summit', snippet: 'Venue: Hinjewadi convention centre, Phase 1. Doors open 9:30.', at: '2026-09-23T10:00:00+05:30' }] },
    assert: {
      modelInput: [{
        turn: 2,
        mustContain: [
          'Pune product summit, 22 to 24 Nov',
          'under 5,000 a night',
          'Look before you ask: their calendars (all of them, not just the main one), mail, memory',
          'Ask only for what is still unknown and would change the result, once, in one message that also confirms what you inferred',
          'Otherwise go ahead and say what you assumed.',
        ],
        mustNotContain: REMOVED_ASKING_RULES,
      }],
    },
  },
  {
    // Nothing known fills the gaps, so the one batched question is the right move; the policy and its limits are in view.
    id: 'asking-vague-ask-gets-one-question',
    category: 'asking',
    turns: ["Plan something for Dad's retirement."],
    llm: [
      { match: /Dad's retirement/, rounds: [{ text: 'When is it, how many people, and roughly what budget? And home, a restaurant or a hall?' }] },
    ],
    assert: {
      modelInput: [{
        turn: 1,
        mustContain: [
          "Plan something for Dad's retirement.",
          'Never reply with only a question, a link or a list of sites when some of the work could already be done.',
          'Reading, searching and comparing can run on stated assumptions.',
        ],
        mustNotContain: REMOVED_ASKING_RULES,
      }],
    },
  },
  {
    // "Just retry" after a failed search reaches the model with the earlier attempt and the rule that it means work.
    id: 'asking-retry-means-work',
    category: 'asking',
    turns: ['What time does the Lalbagh flower show open on Saturday?', 'just retry, keep trying different ways'],
    llm: [
      { match: /Lalbagh flower show/, rounds: [
        { toolCalls: [{ name: 'web_search', arguments: { query: 'Lalbagh flower show Saturday opening time' } }] },
        { text: 'The search came back empty, so I could not confirm the opening time.' },
      ] },
      { match: /just retry/, rounds: [
        { toolCalls: [{ name: 'web_search', arguments: { query: 'Lalbagh flower show timings' } }] },
        { text: 'Still nothing from the search. The horticulture department page is the next place to look.' },
      ] },
    ],
    fixtures: { web: [] },
    assert: {
      modelInput: [{
        turn: 2,
        mustContain: [
          'just retry, keep trying different ways',
          'The search came back empty',
          '"Try again" or "keep going" means work: change your approach and try, don\'t explain.',
          'an error message is not a reason to stop',
          "say what you tried, what you found and what you'd try next",
        ],
        mustNotContain: REMOVED_ASKING_RULES,
      }],
    },
  },
  {
    // "Book it" reaches the model with the rule that bookings need confirmed details and a yes, and that browsing stops short.
    id: 'asking-book-it-needs-a-yes',
    category: 'asking',
    turns: ['Find me a train from Bengaluru to Mysuru on Sunday morning.', 'Book the first one.'],
    llm: [
      { match: /train from Bengaluru/, rounds: [
        { toolCalls: [{ name: 'web_search', arguments: { query: 'Bengaluru to Mysuru train Sunday morning' } }] },
        { text: 'Two morning trains on IRCTC, at 6:10 and 7:30, links below.' },
      ] },
      { match: /Book the first one/, rounds: [{ text: 'I can\'t book it myself. Here is the IRCTC link with the 6:10 train, Sunday, one adult.' }] },
    ],
    fixtures: { web: [{ title: 'Bengaluru to Mysuru trains', url: 'https://www.irctc.co.in/nget/train-search', snippet: 'Morning departures from KSR Bengaluru.' }] },
    assert: {
      modelInput: [{
        turn: 2,
        mustContain: [
          'Book the first one.',
          "Booking, paying, sending something to another person or changing a shared calendar needs confirmed details and the owner's clear yes.",
          'Browsing stops before those steps',
          'trains on IRCTC',
        ],
        mustNotContain: REMOVED_ASKING_RULES,
      }],
    },
  },
];
