import OpenAI from 'openai';
import { z } from 'zod';
import { OPENAI_GPT_6_LUNA_MODEL, sanitiseResultSchema, type SanitiseInput, type SanitiseResult } from '@waldo/contracts';
import { validModelCredential } from './credential-shape';

// Which model an owner's own turn runs on is a judgement the router model makes once, before the turn's first reply
// call. Every doubt keeps the complex tier: a turn wrongly sent to the small model costs the owner a worse answer,
// while one wrongly kept on the large model costs cents.

export type TurnTier = 'simple' | 'complex';
export type TurnTierReason = 'simple' | 'complex' | 'other' | 'low_confidence' | 'refusal' | 'invalid_response' | 'unknown_choice' | 'bad_probabilities' | 'timeout' | 'transport_error' | 'sanitise_rejected';
export type TurnTierRoute = Readonly<{ tier: TurnTier; reason: TurnTierReason; confidence?: number; inputTokens?: number }>;
export type TurnTierInput = Readonly<{ current: string; previousOwner?: string; previousReply?: string }>;
export type TurnTierDecider = (input: TurnTierInput, signal?: AbortSignal) => Promise<TurnTierRoute>;
// The responder supplies its own sanitiser and session canaries; the host supplies how the router is reached.
export type TurnTierFactory = (deps: Readonly<{ sanitise: Sanitise | undefined; canaryTokens: readonly string[] }>) => TurnTierDecider;

// A simple answer below this confidence stays complex. The router's confidence is its own estimate, so the floor sits
// well above a coin flip between the tiers; lowering it buys more small-model turns at more risk of a weak answer.
export const TURN_TIER_CONFIDENCE_FLOOR = 0.8;
// The router answers in about a second; past this the turn stops waiting and takes the complex tier.
export const TURN_TIER_TIMEOUT_MS = 5_000;
// Enough of the previous exchange to judge a follow-up ("same for Koramangala"), and no more.
export const TURN_TIER_EXCERPT_CHARS = 500;
export const TURN_TIER_CURRENT_CHARS = 4_000;
const PROBABILITY_SUM_TOLERANCE = 0.02;

const CHOICES = [
  { value: 'simple', description: 'A direct answer from what Waldo already knows, or one quick lookup: a greeting, thanks, short chat, what is on the calendar for a day, setting a reminder, one fact.' },
  { value: 'complex', description: 'Multi-step work: research across websites or sources, comparisons, planning, booking or errand preparation, drafting from several inputs, anything that needs browsing or several tools, or anything where a wrong answer costs the owner.' },
  { value: 'other', description: 'Fits neither description.' },
] as const;
type ChoiceValue = (typeof CHOICES)[number]['value'];
const OFFERED: ReadonlySet<string> = new Set(CHOICES.map(entry => entry.value));
const TIER_QUESTION = {
  type: 'choice',
  name: 'tier',
  instructions: "Classify how much work the owner's current message asks of Waldo, a personal assistant. Earlier messages are context for follow-ups only. If you are unsure, pick complex.",
  choices: CHOICES,
} as const;

type Sanitise = (input: SanitiseInput) => SanitiseResult | Promise<SanitiseResult>;
export type DecisionsRequest = Readonly<{ model: typeof OPENAI_GPT_6_LUNA_MODEL; input: string; questions: readonly [typeof TIER_QUESTION] }>;
export type DecisionsPost = (body: DecisionsRequest, signal: AbortSignal) => Promise<unknown>;

const choiceAnswer = z.object({
  type: z.literal('choice'), name: z.string(), choice: z.string(), confidence: z.number().min(0).max(1),
  probabilities: z.array(z.object({ value: z.string(), probability: z.unknown() })),
});
const refusalAnswer = z.object({ type: z.literal('refusal'), name: z.string() });
const decisionsResponse = z.object({
  answers: z.array(z.union([choiceAnswer, refusalAnswer, z.object({ name: z.string() })])),
  usage: z.object({ input_tokens: z.number().int().nonnegative().optional() }).optional(),
});

const excerpt = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)} [cut]` : text;
// The turn travels to the sanitiser as conversation messages, the shape the reply's own history is checked in.
const routerMessages = ({ current, previousOwner, previousReply }: TurnTierInput) => [
  ...(previousOwner === undefined ? [] : [{ role: 'user' as const, content: excerpt(previousOwner, TURN_TIER_EXCERPT_CHARS) }]),
  ...(previousReply === undefined ? [] : [{ role: 'assistant' as const, content: excerpt(previousReply, TURN_TIER_EXCERPT_CHARS) }]),
  { role: 'user' as const, content: excerpt(current, TURN_TIER_CURRENT_CHARS) },
];
const sanitisedMessages = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1);
const routerInput = (messages: z.infer<typeof sanitisedMessages>): string => messages
  .map((message, index) => `${index === messages.length - 1 ? 'Owner, now' : message.role === 'user' ? 'Owner, earlier' : 'Waldo, earlier'}: ${message.content}`)
  .join('\n\n');

const complexBecause = (reason: TurnTierReason, confidence?: number): TurnTierRoute => ({ tier: 'complex', reason, ...(confidence === undefined ? {} : { confidence }) });

export const readTierAnswer = (raw: unknown): TurnTierRoute => {
  const parsed = decisionsResponse.safeParse(raw);
  if (!parsed.success) return complexBecause('invalid_response');
  const inputTokens = parsed.data.usage?.input_tokens;
  const tokens = inputTokens === undefined ? {} : { inputTokens };
  const answers = parsed.data.answers.filter(answer => answer.name === TIER_QUESTION.name);
  if (answers.length !== 1 || parsed.data.answers.length !== 1) return { ...complexBecause('invalid_response'), ...tokens };
  const answer = answers[0]!;
  if (!('type' in answer)) return { ...complexBecause('invalid_response'), ...tokens };
  if (answer.type === 'refusal') return { ...complexBecause('refusal'), ...tokens };
  if (!OFFERED.has(answer.choice)) return { ...complexBecause('unknown_choice', answer.confidence), ...tokens };
  const probabilities = answer.probabilities.map(entry => ({ value: entry.value, probability: typeof entry.probability === 'number' ? entry.probability : Number.NaN }));
  const values = probabilities.map(entry => entry.value);
  const chosen = probabilities.find(entry => entry.value === answer.choice);
  const consistent = probabilities.every(entry => OFFERED.has(entry.value) && Number.isFinite(entry.probability) && entry.probability >= 0 && entry.probability <= 1)
    && new Set(values).size === values.length
    && Math.abs(probabilities.reduce((sum, entry) => sum + entry.probability, 0) - 1) <= PROBABILITY_SUM_TOLERANCE
    && chosen !== undefined && probabilities.every(entry => entry.probability <= chosen.probability);
  if (!consistent) return { ...complexBecause('bad_probabilities', answer.confidence), ...tokens };
  const choice = answer.choice as ChoiceValue;
  if (choice !== 'simple') return { ...complexBecause(choice, answer.confidence), ...tokens };
  if (answer.confidence < TURN_TIER_CONFIDENCE_FLOOR) return { ...complexBecause('low_confidence', answer.confidence), ...tokens };
  return { tier: 'simple', reason: 'simple', confidence: answer.confidence, ...tokens };
};

// The text leaves for the router only as the sanitiser returns it, under the owner's own taint, like the reply's history.
export const createTurnTierDecider = ({ post, sanitise, canaryTokens, timeoutMs = TURN_TIER_TIMEOUT_MS }: Readonly<{
  post: DecisionsPost; sanitise: Sanitise | undefined; canaryTokens: readonly string[]; timeoutMs?: number;
}>): TurnTierDecider => async (input, signal) => {
  let text: string;
  try {
    if (!sanitise) return complexBecause('sanitise_rejected');
    const result = sanitiseResultSchema.parse(await sanitise({ payload: routerMessages(input), destination: 'internal_context', canary_tokens: [...canaryTokens], source_taint: null }));
    if (!result.ok || result.source_taint !== null) return complexBecause('sanitise_rejected');
    const messages = sanitisedMessages.safeParse(result.payload);
    if (!messages.success) return complexBecause('sanitise_rejected');
    text = routerInput(messages.data);
  } catch {
    return complexBecause('sanitise_rejected');
  }
  const controller = new AbortController();
  let settleStopped: () => void = () => undefined;
  const stopped = new Promise<'stopped'>(resolve => { settleStopped = () => resolve('stopped'); });
  const stop = () => { controller.abort(); settleStopped(); };
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, timeoutMs); });
  try {
    const outcome = await Promise.race([post({ model: OPENAI_GPT_6_LUNA_MODEL, input: text, questions: [TIER_QUESTION] }, controller.signal).then(raw => ({ raw })), timedOut, stopped]);
    if (outcome === 'timeout') return complexBecause('timeout');
    if (outcome === 'stopped') return complexBecause('transport_error');
    return readTierAnswer(outcome.raw);
  } catch {
    // Only the reason code leaves: a provider error message can quote the request.
    return complexBecause('transport_error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
};

// The installed SDK has no decisions resource; its generic post keeps the client's auth and timeout. Retries stay off:
// the turn has one retry owner, and a router retry would only spend the owner's wait.
export const openAIDecisionsPost = (apiKey: string, { timeoutMs = TURN_TIER_TIMEOUT_MS, fetch }: Readonly<{ timeoutMs?: number; fetch?: typeof globalThis.fetch }> = {}): DecisionsPost => {
  if (!validModelCredential(apiKey)) return async () => { throw new Error('model credential unavailable'); };
  let client: OpenAI | undefined;
  return (body, signal) => (client ??= new OpenAI({ apiKey, maxRetries: 0, timeout: timeoutMs, ...(fetch ? { fetch } : {}) })).post('/decisions', { body, signal });
};

// The deployed router: the Decisions API on the owner's model key.
export const liveTurnTier = (apiKey: string): TurnTierFactory => {
  const post = openAIDecisionsPost(apiKey);
  return deps => createTurnTierDecider({ post, ...deps });
};
