import { z } from 'zod';

// Bringing memories in from another assistant. The owner copies APP_MEMORY_IMPORT_PROMPT_V1 into ChatGPT, Claude, Gemini, Grok
// or another assistant that knows them, and pastes the Markdown it writes back into the app or the website. Waldo reads that
// document once and keeps what it says about the owner as memory.
//
// - What is kept: claims about the owner, each quoting the document. They are Waldo's read ("Waldo thinks") until the owner
//   confirms them in "What Waldo knows": another assistant wrote the document, so it is outside content, not the owner's words.
// - Never kept: health readings, secrets, anything the owner asked Waldo to forget, and anything the owner already dismissed
//   or corrected. The document itself is not stored; only the claims taken from it are.
// - The owner can forget a whole import by naming its source to Waldo, as for an imported chat export.
// - GET says whether this Waldo takes imports. A Worker without the route answers 404, which a client reads as unavailable.

export const APP_MEMORY_IMPORT_PATH_V1 = '/app/v1/memory/import';
export const APP_MEMORY_IMPORT_SOURCES_V1 = ['chatgpt', 'claude', 'gemini', 'grok', 'other'] as const;
export const appMemoryImportSourceV1Schema = z.enum(APP_MEMORY_IMPORT_SOURCES_V1);
export type AppMemoryImportSourceV1 = z.infer<typeof appMemoryImportSourceV1Schema>;
// The names the app and the website show for each source.
export const APP_MEMORY_IMPORT_SOURCE_NAMES_V1: Readonly<Record<AppMemoryImportSourceV1, string>> = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', other: 'Another AI',
};
// A document shorter than this says nothing worth reading; longer than the maximum is refused rather than cut.
export const APP_MEMORY_IMPORT_TEXT_MIN_V1 = 40;
export const APP_MEMORY_IMPORT_TEXT_MAX_V1 = 40_000;
// The maximum text at four bytes a character, with room for JSON escapes and the other fields.
export const APP_MEMORY_IMPORT_MAX_REQUEST_BYTES_V1 = 200_000;
// At most this many claims are kept from one document.
export const APP_MEMORY_IMPORT_CLAIMS_MAX_V1 = 60;

// The prompt the owner copies into the other assistant. It is contract so the app, the website and Waldo show one text.
export const APP_MEMORY_IMPORT_PROMPT_V1 = [
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

export const appMemoryImportStatusV1Schema = z.strictObject({
  version: z.literal(1),
  // false: this Waldo does not take imports yet; a client hides the option.
  available: z.boolean(),
});

export const appMemoryImportRequestV1Schema = z.strictObject({
  request_id: z.string().regex(/^[A-Za-z0-9_-]{8,96}$/),
  source: appMemoryImportSourceV1Schema,
  text: z.string().trim().min(APP_MEMORY_IMPORT_TEXT_MIN_V1).max(APP_MEMORY_IMPORT_TEXT_MAX_V1),
});

// imported: at least one new claim was kept. nothing_new: the document was read and nothing in it was new or keepable.
// added, already_known and left_out count claims: kept now, already in memory, and refused (a health reading, a secret, a
// forgotten topic, an owner's earlier decision, or a quote not in the document).
export const appMemoryImportResultV1Schema = z.strictObject({
  version: z.literal(1),
  state: z.enum(['imported', 'nothing_new']),
  added: z.int().min(0).max(APP_MEMORY_IMPORT_CLAIMS_MAX_V1),
  already_known: z.int().min(0).max(APP_MEMORY_IMPORT_CLAIMS_MAX_V1),
  left_out: z.int().min(0).max(APP_MEMORY_IMPORT_CLAIMS_MAX_V1),
  message: z.string().min(1).max(500),
});

// Errors carry { error } only: invalid_request (400), request_reused (409, the same request_id with a different body),
// agreements_required (409), rate_limited (429), unavailable (503: switched off, or the read failed; nothing was kept).
export const APP_MEMORY_IMPORT_ERRORS_V1 = ['invalid_request', 'request_reused', 'agreements_required', 'rate_limited', 'unavailable'] as const;

export const appMemoryImportRoutesV1 = [
  { method: 'GET', path: APP_MEMORY_IMPORT_PATH_V1, response: appMemoryImportStatusV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: APP_MEMORY_IMPORT_PATH_V1, request: appMemoryImportRequestV1Schema, response: appMemoryImportResultV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: APP_MEMORY_IMPORT_MAX_REQUEST_BYTES_V1 },
] as const;

export type AppMemoryImportStatusV1 = z.infer<typeof appMemoryImportStatusV1Schema>;
export type AppMemoryImportRequestV1 = z.infer<typeof appMemoryImportRequestV1Schema>;
export type AppMemoryImportResultV1 = z.infer<typeof appMemoryImportResultV1Schema>;
