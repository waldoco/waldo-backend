import type { CalendarItem } from '../connectors/google';
import { isReviewedGranola } from '../connectors/granola-mcp';
import type { McpToolDef } from '../connectors/mcp-tools';

// Granola's notes from earlier meetings with the same people, for a meeting the owner organized or accepted. The harness
// makes this read, not the model: one question built in code from the attendees' addresses alone, never the title or
// description, which someone else may have written, to the reviewed Granola server only, through its read path.
export const GRANOLA_PREP_TOOL = 'query_granola_meetings';
const ATTENDEES = 10;
// An address is someone else's chosen text even when it is valid, so it is held to the longest an address can be.
const ADDRESS_CHARS = 254;
const ADDRESS = /^[^\s@{}()"<>,;]+@[^\s@{}()"<>,;]+\.[^\s@{}()"<>,;]+$/;
// Prep reads this much of Granola's answer, so the mail findings after it in the prompt keep their room.
export const GRANOLA_ANSWER_CHARS = 16_384;

// A notetaker's answer is waited on this long: prep has to reach the owner before the meeting, so a read that hangs is a
// read that failed.
export const PREP_READ_MS = 30_000;
export const inTime = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('prep_read_timeout')), PREP_READ_MS);
  work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

export type GranolaSkip = 'not_connected' | 'not_reviewed' | 'reauth_needed' | 'no_attendees' | 'schema_unexpected' | 'read_failed' | 'empty';
export type GranolaRead = Readonly<{ status: 'read'; text: string }> | Readonly<{ status: 'skipped'; code: GranolaSkip }>;
export type PrepGranolaDeps = Readonly<{
  // The owner's Granola connection, if any.
  connection(): Readonly<{ name: string; server_url: string; issuer: string | null; status: 'active' | 'reauth_needed' }> | undefined;
  describe(server: string, tool: string): Promise<Readonly<{ def: McpToolDef }>>;
  invoke(input: Readonly<{ server: string; tool: string; args: Readonly<Record<string, unknown>>; mode: 'read' }>): Promise<Readonly<{ server: string; result: unknown } | { server: string; input_required: unknown }>>;
}>;

// The other attendees a notetaker is asked about: well-formed addresses only, lower-cased, never the owner's own.
export const prepAttendees = (event: CalendarItem, owner: string | null): string[] =>
  [...new Set((event.attendee_emails ?? []).map(email => email.toLowerCase()).filter(email => email.length <= ADDRESS_CHARS && ADDRESS.test(email) && email !== owner?.toLowerCase()))].slice(0, ATTENDEES);

export const granolaQuestion = (people: readonly string[]): string =>
  `What did I discuss in earlier meetings with ${people.slice(0, ATTENDEES).join(', ')}? What was decided, and what is still open or owed by anyone?`;

// The tool's one string argument: its only required property, or, with none required, its only property, when that is a
// string. Any other shape is one Waldo has not reviewed, so nothing is sent.
export const questionArgument = (def: Pick<McpToolDef, 'inputSchema'>): string | null => {
  const schema = def.inputSchema as { type?: unknown; properties?: Record<string, { type?: unknown }>; required?: unknown };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const candidates = required.length ? required : Object.keys(schema.properties ?? {});
  const [name] = candidates;
  return schema.type === 'object' && candidates.length === 1 && typeof name === 'string' && schema.properties?.[name]?.type === 'string' ? name : null;
};

export const answerText = (result: unknown): string => {
  const content = (result as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? content.flatMap(part => (part as { type?: unknown; text?: unknown })?.type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n').trim() : '';
};

export const prepGranola = async (deps: PrepGranolaDeps, event: CalendarItem, owner: string | null): Promise<GranolaRead> => {
  const skipped = (code: GranolaSkip): GranolaRead => ({ status: 'skipped', code });
  const connection = deps.connection();
  if (!connection) return skipped('not_connected');
  if (!isReviewedGranola(connection.server_url, connection.issuer)) return skipped('not_reviewed');
  if (connection.status !== 'active') return skipped('reauth_needed');
  const people = prepAttendees(event, owner);
  if (!people.length) return skipped('no_attendees');
  try {
    const argument = questionArgument((await inTime(deps.describe(connection.name, GRANOLA_PREP_TOOL))).def);
    if (!argument) return skipped('schema_unexpected');
    const answer = await inTime(deps.invoke({ server: connection.name, tool: GRANOLA_PREP_TOOL, args: { [argument]: granolaQuestion(people) }, mode: 'read' }));
    if (!('result' in answer)) return skipped('read_failed');
    const text = answerText(answer.result);
    if (!text) return skipped('empty');
    return { status: 'read', text: text.length > GRANOLA_ANSWER_CHARS ? `${text.slice(0, GRANOLA_ANSWER_CHARS)}\n[Granola's answer continues; prep read only this much of it.]` : text };
  } catch {
    // A read that fails leaves the brief to its other sources; the caller logs the code.
    return skipped('read_failed');
  }
};
