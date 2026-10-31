import { literalTextRedactor, type ConversationModelMessage, type LLMToolTurn } from '@waldo/contracts';
import type { Claim, ClaimStore } from '../memory/claims';
import { carriesTopic, holdsIn } from '../memory/forget-guard';
import { toolOfCall } from '../tools/loader';

// The one place the model's view is cut for topics the owner asked to forget whose purge has not finished. A forget is a
// privacy boundary, so the cut is deterministic; its cost lands on the forgotten words, not on the reads around them.
//   items: owner memory drops the matching item; other text has the words replaced and keeps the rest. Nothing is withheld whole.
//   reads: the earlier rule, kept as the flag-off path: a held string or key outside a list withholds the whole read.
export type ForgetBarrierMode = 'items' | 'reads';
// code: text this repository wrote, never cut (a forget of "team" must not break the behaviour prompt).
// owner_record: the owner's own conversation, standing orders and loops; owner_store: memory Waldo keeps about the owner.
// In both an item (a message, a line, a claim) is a unit of meaning, dropped whole.
// external: everything from outside the owner, where the surrounding text stays useful once the words are gone.
export type ViewOrigin = 'code' | 'owner_record' | 'owner_store' | 'external';
export type ResultOrigin = Extract<ViewOrigin, 'owner_store' | 'external'>;
export type BarrierTally = { dropped: number; redacted: number };

export const FORGET_MARKER = '[forgotten]';
export const WITHHELD_OUTPUT = '[waldo: this tool returned data that mentions a topic the owner asked to forget, so it is withheld. The tool DID return data - do not report it as empty or failed; say that part is withheld.]';
const OWNER_STORE_TOOLS: ReadonlySet<string> = new Set(['read_memory', 'search_episodes']);
export const resultOrigin = (tool: string): ResultOrigin => (OWNER_STORE_TOOLS.has(tool) ? 'owner_store' : 'external');

// Every string in a structured value (keys and values), unserialised: JSON.stringify would double a stored backslash and
// hide an escaped topic from hidesTopic.
export const structuredStrings = (value: unknown, depth = 0): string[] => {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || depth > 64) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...structuredStrings(child, depth + 1)]);
};

const removalNote = ({ dropped, redacted }: BarrierTally): string => {
  const parts = [dropped ? `${dropped} item${dropped === 1 ? '' : 's'}` : '', redacted ? `${redacted} passage${redacted === 1 ? '' : 's'}` : ''].filter(Boolean);
  return `[waldo: ${parts.join(' and ')} mentioning a topic the owner asked to forget ${dropped + redacted === 1 ? 'was' : 'were'} removed; the rest is shown. Do not report the result as empty.]`;
};

// Escapes read the most permissive way any reader takes them, as the storage test reads them: \uXXXX and \xHH as the
// character they name, the simple and control escapes as theirs, a backslash before a line break or at the end as nothing,
// and any other escaped character as itself. A path or a regex reads as letters that carry nothing, so it costs nothing.
const ESCAPES: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '0': '\0', v: '\v' };
const decodeOnce = (value: string): string =>
  value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S]|$)/gu, (_match, escape: string) =>
    escape.length > 2 ? String.fromCharCode(parseInt(escape.slice(1), 16))
      : /^(?:\r\n|[\n\r\u2028\u2029])?$/.test(escape) ? '' : ESCAPES[escape] ?? escape);
// Every pass that decodes something shortens the text, so this ends; nesting cannot hide the topic.
const decodeEscapes = (value: string): string => {
  for (let next = decodeOnce(value); next !== value; next = decodeOnce(value)) value = next;
  return value;
};

export const forgetBarrier = (held: readonly string[], mode: ForgetBarrierMode = 'items') => {
  const topics = [...new Set(held.map((topic) => topic.trim()).filter(Boolean))];
  const redactWords = literalTextRedactor(topics, FORGET_MARKER);
  // The storage-grade test, the one the purge reads back by: an escape it cannot rule out counts as the topic. Owner memory
  // items are judged by it, so a doubtful item is dropped rather than shown.
  const holds = holdsIn(topics);
  // What a reader of the text could see: the topic as written, spelled by an escape, or by escapes nested in escapes.
  const shows = (value: string): boolean =>
    holds(value) || (value.includes('\\') && topics.some((topic) => carriesTopic(decodeEscapes(value), topic)));

  // Text from outside the owner's memory: the words go, the rest stays. Text keeps its own spelling unless the topic hides
  // behind escapes, which are then decoded so the words can be removed. undefined is the flag-off rule's whole-read hold.
  const text = (value: string, tally: BarrierTally): string | undefined => {
    if (mode === 'reads') return holds(value) ? undefined : value;
    if (!shows(value)) return value;
    tally.redacted += 1;
    const redacted = redactWords(value);
    return shows(redacted) ? redactWords(decodeEscapes(value)) : redacted;
  };

  // A structured result. Owner memory drops list items that carry a topic; any other list keeps its items with the words
  // replaced. undefined means the whole value is withheld, which items mode never returns.
  const structured = <T,>(value: T, origin: ResultOrigin, tally: BarrierTally, depth = 0): T | undefined => {
    if (typeof value === 'string') return text(value, tally) as T | undefined;
    if (value === null || typeof value !== 'object') return value;
    if (depth > 64) return mode === 'reads' ? undefined : value;
    if (Array.isArray(value)) {
      const dropItems = mode === 'reads' || origin === 'owner_store';
      const kept = dropItems ? value.filter((item) => !holds(...structuredStrings(item))) : value;
      tally.dropped += value.length - kept.length;
      const out = [];
      for (const item of kept) {
        const child = structured(item, origin, tally, depth + 1);
        if (child === undefined) return undefined;
        out.push(child);
      }
      return out as T;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const keptKey = text(key, tally);
      if (keptKey === undefined) return undefined;
      const kept = structured(child, origin, tally, depth + 1);
      if (kept === undefined && child !== undefined) return undefined;
      out[keptKey] = kept;
    }
    return out as T;
  };

  // A tool output as the model reads it: its JSON line is cut like any structured result and the loop's own notes after it
  // ride along; text that is not JSON is cut as text.
  const output = (raw: string, origin: ResultOrigin): string => {
    const clean = (value: string) => (mode === 'items' ? !shows(value) : !holds(value));
    if (clean(raw)) return raw;
    const cut = raw.indexOf('\n');
    const head = cut === -1 ? raw : raw.slice(0, cut);
    const rest = cut === -1 ? '' : raw.slice(cut);
    const tally: BarrierTally = { dropped: 0, redacted: 0 };
    let parsed: unknown;
    try { parsed = JSON.parse(head); } catch {
      const kept = text(raw, tally);
      if (kept === undefined) return WITHHELD_OUTPUT;
      return tally.redacted ? `${kept}\n${removalNote(tally)}` : kept;
    }
    const kept = structured(parsed, origin, tally);
    if (kept === undefined) return WITHHELD_OUTPUT;
    if (!tally.dropped && !tally.redacted) return clean(raw) ? raw : WITHHELD_OUTPUT;
    const narrowed = `${JSON.stringify(kept)}\n${removalNote(tally)}${rest}`;
    return clean(narrowed) ? narrowed : WITHHELD_OUTPUT;
  };

  // The model's own calls keep their results in place: dropping a turn would leave its function call unanswered.
  const turns = (list: readonly LLMToolTurn[]): LLMToolTurn[] =>
    list.map((turn) => (toolOfCall(turn.call) === 'forget_memory' ? turn : { ...turn, output: output(turn.output, resultOrigin(toolOfCall(turn.call))) }));

  // A list of outside texts (earlier tool results): the words go from each. The flag-off rule dropped any that held.
  const texts = <T,>(list: readonly T[], textOf: (item: T) => string, withText: (item: T, text: string) => T): T[] =>
    list.flatMap((item) => {
      const kept = text(textOf(item), { dropped: 0, redacted: 0 });
      return kept === undefined ? [] : [kept === textOf(item) ? item : withText(item, kept)];
    });

  // Text this repository wrote is never cut; the flag-off rule dropped it whole.
  const code = (value: string): string => (mode === 'reads' && holds(value) ? '' : value);

  return { mode, active: topics.length > 0, holds, shows, text, structured, output, turns, texts, code };
};

export type ForgetBarrier = ReturnType<typeof forgetBarrier>;

// What one model call is shown, part by part. lines holds one item per line; sized produces lines under a room budget,
// so the budget is spent before the cut and the cut runs on what is produced; messages is the conversation, whose last
// entry is the owner's current message and is never cut.
export type ViewFragment =
  | Readonly<{ kind: 'text'; origin: ViewOrigin; text: string }>
  | Readonly<{ kind: 'lines'; origin: ViewOrigin; text: string }>
  | Readonly<{ kind: 'sized'; origin: ViewOrigin; text: (room: number) => string }>
  | Readonly<{ kind: 'messages'; messages: readonly ConversationModelMessage[] }>
  | Readonly<{ kind: 'turns'; turns: readonly LLMToolTurn[] }>;
export type CutFragment<F extends ViewFragment> =
  F extends { kind: 'sized' } ? (room: number) => string
    : F extends { kind: 'messages' } ? ConversationModelMessage[]
      : F extends { kind: 'turns' } ? LLMToolTurn[]
        : string;

// The forget barrier over a whole model view, applied once per model call: every part bound for the model crosses it.
export const applyForgetBarrier = <V extends Record<string, ViewFragment>>(view: V, held: readonly string[], mode: ForgetBarrierMode = 'items'): { [K in keyof V]: CutFragment<V[K]> } => {
  const cut = forgetBarrier(held, mode);
  const tally = (): BarrierTally => ({ dropped: 0, redacted: 0 });
  const piece = (origin: ViewOrigin, text: string): string =>
    origin === 'code' ? cut.code(text) : origin === 'external' ? cut.text(text, tally()) ?? '' : cut.holds(text) ? '' : text;
  // A line cut to nothing is dropped; a line that was blank stays, so the layout around the items holds.
  const lines = (origin: ViewOrigin, text: string): string => {
    if (!cut.active || origin === 'code') return piece(origin, text);
    return text.split('\n').flatMap((line) => {
      if (line === '') return [line];
      const kept = piece(origin, line);
      return kept === '' ? [] : [kept];
    }).join('\n');
  };
  const out: Record<string, unknown> = {};
  for (const [key, fragment] of Object.entries(view)) {
    if (fragment.kind === 'text') out[key] = cut.active ? piece(fragment.origin, fragment.text) : fragment.text;
    else if (fragment.kind === 'lines') out[key] = lines(fragment.origin, fragment.text);
    else if (fragment.kind === 'sized') out[key] = (room: number) => lines(fragment.origin, fragment.text(room));
    else if (fragment.kind === 'messages') out[key] = fragment.messages.filter((message, index) => index === fragment.messages.length - 1 || !cut.holds(message.content));
    else out[key] = cut.active ? cut.turns(fragment.turns) : [...fragment.turns];
  }
  return out as { [K in keyof V]: CutFragment<V[K]> };
};

// The owner's memory as the model may see it while a forget finishes: claims and recall without the items that carry a held
// topic, and interpretations built on them withheld with them. It is cut at the store, not as rendered lines, because the
// cascade from a claim to the nodes and edges that rest on it needs the store's structure, and the room budget is then spent
// on what survives. held is read on each call, so a forget made mid-turn applies at once.
export const barrierMemory = (store: ClaimStore, held: () => readonly string[]): ClaimStore => {
  const claimHolds = (holds: (...values: readonly (string | null | undefined)[]) => boolean) => (claim: Claim) =>
    holds(claim.text, claim.evidence, claim.source_ref, (claim as { aliases?: string | null }).aliases);
  const nodes = (topics: readonly string[]) => {
    const holds = holdsIn(topics);
    const all = store.allClaims();
    const known = new Set(all.map((claim) => claim.id));
    const withheld = new Set(all.filter(claimHolds(holds)).map((claim) => claim.id));
    // While a topic is held, support naming a claim that does not exist has unknown provenance, so it fails closed like
    // unreadable support.
    const supportHeld = (raw: string): boolean => {
      try {
        const spots: unknown = JSON.parse(raw);
        return !Array.isArray(spots) || spots.some((id) => typeof id !== 'number' || withheld.has(id) || (topics.length > 0 && !known.has(id)));
      } catch { return true; }
    };
    return store.nodes().filter((node) => !holds(...structuredStrings(node)) && !supportHeld(node.supporting_spots));
  };
  return {
    ...store,
    nodes: () => nodes(held()),
    edges: () => {
      const topics = held();
      const holds = holdsIn(topics);
      const kept = new Set(nodes(topics).map((node) => node.id));
      return store.edges().filter((edge) => kept.has(edge.from_id) && kept.has(edge.to_id) && !holds(...structuredStrings(edge)));
    },
    // The held set is read once per call, not once per claim.
    claims: (status) => { const holds = claimHolds(holdsIn(held())); return store.claims(status).filter((claim) => !holds(claim)); },
    recall: (query, limit, near) => { const holds = claimHolds(holdsIn(held())); return store.recall(query, limit, near).filter((claim) => !holds(claim)); },
    statements: () => { const holds = claimHolds(holdsIn(held())); return store.statements().filter((claim) => !holds(claim)); },
  };
};
