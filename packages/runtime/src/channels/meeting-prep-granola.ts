import type { CalendarItem } from '../connectors/google';
import { isReviewedGranola } from '../connectors/granola-mcp';
import type { McpToolDef } from '../connectors/mcp-tools';
import { checkedGranola, type GranolaNotes } from './event-briefs';

// Granola's notes from earlier meetings with the same people, for a meeting the owner organized or accepted. The harness
// makes this read, not the model: one question built in code from the attendees' addresses alone, never the title or
// description, which someone else may have written, to the reviewed Granola server only, through its read path.
export const GRANOLA_PREP_TOOL = 'query_granola_meetings';
const ATTENDEES = 10;
const ADDRESS = /^[^\s@{}()"<>,;]+@[^\s@{}()"<>,;]+\.[^\s@{}()"<>,;]+$/;

export type GranolaSkip = 'not_connected' | 'not_reviewed' | 'reauth_needed' | 'no_attendees' | 'schema_unexpected' | 'read_failed' | 'empty';
export type GranolaRead = Readonly<{ status: 'read'; text: string }> | Readonly<{ status: 'skipped'; code: GranolaSkip }>;
export type PrepGranolaDeps = Readonly<{
  // The owner's Granola connection, if any.
  connection(): Readonly<{ name: string; server_url: string; issuer: string | null; status: 'active' | 'reauth_needed' }> | undefined;
  describe(server: string, tool: string): Promise<Readonly<{ def: McpToolDef }>>;
  invoke(input: Readonly<{ server: string; tool: string; args: Readonly<Record<string, unknown>>; mode: 'read' }>): Promise<Readonly<{ server: string; result: unknown } | { server: string; input_required: unknown }>>;
}>;

export const granolaQuestion = (people: readonly string[]): string =>
  `What did I discuss in earlier meetings with ${people.slice(0, ATTENDEES).join(', ')}? What was decided, and what is still open or owed by anyone?`;

// The tool's one string argument: its only required property, or, with none required, its only property, when that is a
// string. Any other shape is one Waldo has not reviewed, so nothing is sent.
const questionArgument = (def: McpToolDef): string | null => {
  const schema = def.inputSchema as { type?: unknown; properties?: Record<string, { type?: unknown }>; required?: unknown };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const candidates = required.length ? required : Object.keys(schema.properties ?? {});
  const [name] = candidates;
  return schema.type === 'object' && candidates.length === 1 && typeof name === 'string' && schema.properties?.[name]?.type === 'string' ? name : null;
};

const answerText = (result: unknown): string => {
  const content = (result as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? content.flatMap(part => (part as { type?: unknown; text?: unknown })?.type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n').trim() : '';
};

export const prepGranola = async (deps: PrepGranolaDeps, event: CalendarItem, owner: string | null): Promise<GranolaRead> => {
  const skipped = (code: GranolaSkip): GranolaRead => ({ status: 'skipped', code });
  const connection = deps.connection();
  if (!connection) return skipped('not_connected');
  if (!isReviewedGranola(connection.server_url, connection.issuer)) return skipped('not_reviewed');
  if (connection.status !== 'active') return skipped('reauth_needed');
  const people = [...new Set((event.attendee_emails ?? []).map(email => email.toLowerCase()).filter(email => ADDRESS.test(email) && email !== owner?.toLowerCase()))];
  if (!people.length) return skipped('no_attendees');
  try {
    const argument = questionArgument((await deps.describe(connection.name, GRANOLA_PREP_TOOL)).def);
    if (!argument) return skipped('schema_unexpected');
    const answer = await deps.invoke({ server: connection.name, tool: GRANOLA_PREP_TOOL, args: { [argument]: granolaQuestion(people) }, mode: 'read' });
    if (!('result' in answer)) return skipped('read_failed');
    const text = answerText(answer.result);
    return text ? { status: 'read', text } : skipped('empty');
  } catch {
    // A read that fails leaves the brief to its other sources; the caller logs the code.
    return skipped('read_failed');
  }
};

// What the decision is told: Granola's guarded answer; that Granola is connected but could not be read; or nothing, when it
// is not connected, has nothing, or the meeting has no one to ask about.
export const granolaNotes = (read: GranolaRead): GranolaNotes | undefined => read.status === 'read' ? checkedGranola(read.text)
  : ['reauth_needed', 'schema_unexpected', 'read_failed'].includes(read.code) ? { status: 'unavailable' } : undefined;
