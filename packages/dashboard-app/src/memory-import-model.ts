import { CHAT_URL, ChatRequestError, request } from './chat-model';

// Bringing memories in from another assistant, the way the app does (packages/contracts/src/app/memory-import.ts): the owner
// copies the prompt into that assistant and pastes what it writes back. The values below are the contract's, copied rather than
// imported because the contract would bring zod into the page; memory-import.test checks they agree.
export const MEMORY_IMPORT_URL = `${CHAT_URL}/memory-import`;
export const MEMORY_IMPORT_TEXT_MIN = 40;
export const MEMORY_IMPORT_TEXT_MAX = 40_000;
export const MEMORY_IMPORT_SOURCES = [
  { key: 'chatgpt', label: 'ChatGPT' }, { key: 'claude', label: 'Claude' }, { key: 'gemini', label: 'Gemini' },
  { key: 'grok', label: 'Grok' }, { key: 'other', label: 'Another AI' },
] as const;
export type MemoryImportSource = typeof MEMORY_IMPORT_SOURCES[number]['key'];
export const MEMORY_IMPORT_PROMPT = [
  'I\'m starting to use Waldo, a personal assistant that looks after my day, and I want it to know me as well as you do. Using your memory of me and our past conversations, write one Markdown document about me.',
  '',
  'Use these sections, and leave out any section you know nothing about:',
  '',
  '## About me',
  'Name and what I like to be called, where I live and my time zone, my work or studies, languages I use.',
  '',
  '## People in my life',
  'The people I mention most: name, how they relate to me, and anything I\'ve said matters about them.',
  '',
  '## Work and projects',
  'What I\'m working on now, my goals, deadlines I\'ve mentioned, tools I use.',
  '',
  '## Routines and schedule',
  'When I usually wake, sleep, work, exercise and eat. How I like meetings and my calendar arranged.',
  '',
  '## Health and energy',
  'Only what I\'ve told you: goals, training, sleep, diet, and conditions or medicines I\'ve chosen to share.',
  '',
  '## How I like help',
  'Tone, length and format I prefer, what annoys me, how much you should decide on my own.',
  '',
  '## Patterns you\'ve noticed',
  'How I make decisions, when I do my best work, what tends to get in my way, habits I\'m trying to build or break.',
  '',
  '## Interests',
  'Hobbies, things I follow, places I like.',
  '',
  'Rules:',
  '- Write only what I told you or what you clearly saw in our chats. Do not guess or fill gaps.',
  '- Mark anything you inferred rather than heard from me with "(inferred)".',
  '- Add a date or rough time when you know when something was true.',
  '- Never include passwords, card or bank numbers, ID numbers, or anything I asked you to forget.',
  '- Return the whole document in one Markdown code block so I can copy it.',
].join('\n');

export type MemoryImportResult = { state: 'imported' | 'nothing_new'; added: number; already_known: number; left_out: number; message: string };

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const readResult = (raw: unknown): MemoryImportResult => {
  const value = raw as Record<string, unknown> | null;
  if (!value || (value.state !== 'imported' && value.state !== 'nothing_new') || !count(value.added) || !count(value.already_known) || !count(value.left_out) || typeof value.message !== 'string')
    throw new ChatRequestError(200, 'Waldo sent a reply this console cannot read.');
  return { state: value.state, added: value.added, already_known: value.already_known, left_out: value.left_out, message: value.message };
};

// A Worker without the route answers 404: imports are not here yet, the same as off.
export const memoryImportAvailable = async (): Promise<boolean> => {
  try { const value = await request(MEMORY_IMPORT_URL) as { available?: unknown }; return value?.available === true; }
  catch (error) { if (error instanceof ChatRequestError && error.status === 404) return false; throw error; }
};

// The text the box would refuse before it is sent, or null when the route would take it. The route stays the authority.
export const textRefusal = (text: string): string | null => {
  const length = text.trim().length;
  if (length < MEMORY_IMPORT_TEXT_MIN) return 'Paste the whole document the other AI wrote.';
  if (length > MEMORY_IMPORT_TEXT_MAX) return `That is longer than Waldo reads at once (${MEMORY_IMPORT_TEXT_MAX.toLocaleString('en')} characters). Paste the most useful parts.`;
  return null;
};

export const importMemories = async (source: MemoryImportSource, text: string, requestId: string): Promise<MemoryImportResult> =>
  readResult(await request(MEMORY_IMPORT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_id: requestId, source, text: text.trim() }) }));

// What the panel says when an import did not go, from its status (0 is the network), never the server's own words.
export const importFailureLine = (status: number): string => {
  switch (status) {
    case 0: return 'Can’t reach Waldo. Check your connection and try again.';
    case 400: case 413: return 'Waldo couldn’t read that. Check you pasted the whole document and try again.';
    case 404: return 'Bringing in memories isn’t on for your Waldo yet.';
    case 409: return 'Finish setting up Waldo first, then try again.';
    case 429: return 'Too many tries in a row. Wait a minute, then try again.';
    default: return 'Waldo couldn’t read that just now. Nothing was saved. Try again in a moment.';
  }
};
