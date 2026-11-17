import type { CalendarItem } from '../connectors/google';
import { McpRefusal } from '../connectors/mcp-connections';
import type { McpToolDef } from '../connectors/mcp-tools';
import { answerText, inTime, prepAttendees } from './meeting-prep-granola';

// Fireflies' record of earlier meetings with the same people, for a meeting the owner organized or accepted. The harness
// makes this read, not the model: the tool and its arguments are fixed here, the people are the attendees' addresses alone,
// never the title or description, which someone else may have written. It runs only as the owner allowed the tool in
// Connections: a background read of their meeting recordings is theirs to allow, so a refusal is a skip, not a card.
export const FIREFLIES_PREP_TOOL = 'fireflies_get_transcripts';
// The meetings listed: the latest few with these people are what a prep note draws on.
const MEETINGS = 5;
// Prep reads this much of the list, so the mail findings after it in the prompt keep their room.
export const FIREFLIES_ANSWER_CHARS = 16_384;

export type FirefliesSkip = 'not_connected' | 'reauth_needed' | 'no_attendees' | 'schema_unexpected' | 'not_allowed' | 'read_failed' | 'empty';
export type FirefliesRead = Readonly<{ status: 'read'; text: string }> | Readonly<{ status: 'skipped'; code: FirefliesSkip }>;
export type PrepFirefliesDeps = Readonly<{
  // The owner's Fireflies connection from the catalogue, if any.
  connection(): Readonly<{ name: string; status: 'active' | 'reauth_needed' }> | undefined;
  describe(server: string, tool: string): Promise<Readonly<{ def: McpToolDef }>>;
  invoke(input: Readonly<{ server: string; tool: string; args: Readonly<Record<string, unknown>>; mode: 'read' }>): Promise<Readonly<{ server: string; result: unknown } | { server: string; input_required: unknown }>>;
}>;

// The list call this prep makes, only when the tool still takes the people as a list of strings and requires nothing else.
const listArguments = (def: McpToolDef, people: readonly string[]): Readonly<Record<string, unknown>> | null => {
  const schema = def.inputSchema as { type?: unknown; properties?: Record<string, { type?: unknown }>; required?: unknown };
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (schema.type !== 'object' || schema.properties?.participants?.type !== 'array' || required.some(name => name !== 'participants')) return null;
  return { participants: people, ...(schema.properties.limit ? { limit: MEETINGS } : {}) };
};

export const prepFireflies = async (deps: PrepFirefliesDeps, event: CalendarItem, owner: string | null): Promise<FirefliesRead> => {
  const skipped = (code: FirefliesSkip): FirefliesRead => ({ status: 'skipped', code });
  const connection = deps.connection();
  if (!connection) return skipped('not_connected');
  if (connection.status !== 'active') return skipped('reauth_needed');
  const people = prepAttendees(event, owner);
  if (!people.length) return skipped('no_attendees');
  try {
    const args = listArguments((await inTime(deps.describe(connection.name, FIREFLIES_PREP_TOOL))).def, people);
    if (!args) return skipped('schema_unexpected');
    const answer = await inTime(deps.invoke({ server: connection.name, tool: FIREFLIES_PREP_TOOL, args, mode: 'read' }));
    if (!('result' in answer)) return skipped('read_failed');
    const text = answerText(answer.result);
    if (!text) return skipped('empty');
    return { status: 'read', text: text.length > FIREFLIES_ANSWER_CHARS ? `${text.slice(0, FIREFLIES_ANSWER_CHARS)}\n[Fireflies' list continues; prep read only this much of it.]` : text };
  } catch (error) {
    // A read the owner has not allowed (refused before anything ran), or one that fails, leaves the brief to its other
    // sources; the caller logs the code.
    return skipped(error instanceof McpRefusal && error.code === 'forbidden' && error.notApplied ? 'not_allowed' : 'read_failed');
  }
};
