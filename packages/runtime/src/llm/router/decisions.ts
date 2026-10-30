import { OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
import { z } from 'zod';
import { carriesSecretOrCanary, HEALTH_SPAN_MARKER, redactNumericHealth } from '../../scribe/sanitiser';
import { validModelCredential } from '../credential-shape';
import type { RouterVerdict } from './policy';

// The router's view of a conversation: the latest turns, as said. It sees nothing else of the owner.
export type RouterTurn = Readonly<{ role: 'owner' | 'waldo'; text: string }>;
// The seam the owner turn routes through. Any provider that can answer "which tier" sits behind it; a failure is null.
export type ModelRouter = Readonly<{ route(turns: readonly RouterTurn[]): Promise<RouterVerdict> }>;

export const ROUTER_RECENT_TURNS = 4;
// The router runs beside context composition, so it must answer well inside the time that takes.
export const ROUTER_TIMEOUT_MS = 1_500;
const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
// A shared key for the fixed question prefix; the turns that follow it are what vary.
const ROUTER_CACHE_KEY = 'waldo-router-v1';

const QUESTION = {
  type: 'choice', name: 'tier',
  instructions: 'Which model should answer the latest user message in this conversation with a personal assistant? Judge how much reasoning the reply needs, not how long the message is.',
  choices: [
    { value: 'light', description: 'A quick reply: an acknowledgement, a greeting, a yes or no, or one simple fact.' },
    { value: 'standard', description: 'Ordinary assistant work: planning a day, drafting a message, looking something up and summarising it.' },
    { value: 'deep', description: 'Demanding reasoning: weighing several constraints or people at once, a multi-step plan, a careful judgment with real stakes.' },
  ],
} as const;

const answerSchema = z.object({
  answers: z.tuple([z.object({ type: z.literal('choice'), choice: z.enum(['light', 'standard', 'deep']), confidence: z.number().min(0).max(1) })]).rest(z.unknown()),
});

// OpenAI's Decisions endpoint (POST /v1/decisions, answered by Luna). What leaves follows the embedding egress: a turn carrying a
// secret or canary sends nothing at all, and health readings are withheld. Every failure, refusal, timeout or answer outside
// the three tiers is null, which the route policy turns into Terra or the conversation's current model.
export function openAIDecisionsRouter(options: Readonly<{ apiKey: string; fetch?: typeof fetch; timeoutMs?: number }>): ModelRouter {
  const send = options.fetch ?? fetch;
  return {
    async route(turns) {
      const recent = turns.slice(-ROUTER_RECENT_TURNS);
      if (!validModelCredential(options.apiKey) || recent.length === 0 || recent.some((turn) => carriesSecretOrCanary(turn.text))) return null;
      const input = recent.map((turn) => ({ role: turn.role === 'owner' ? 'user' : 'assistant', content: redactNumericHealth(turn.text, HEALTH_SPAN_MARKER) }));
      try {
        const response = await send(DECISIONS_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: OPENAI_GPT_6_LUNA_MODEL, input, questions: [QUESTION], prompt_cache_key: ROUTER_CACHE_KEY }),
          signal: AbortSignal.timeout(options.timeoutMs ?? ROUTER_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const parsed = answerSchema.safeParse(await response.json());
        if (!parsed.success) return null;
        const [answer] = parsed.data.answers;
        return { tier: answer.choice, confidence: answer.confidence };
      } catch {
        // A routing miss never fails the turn: no verdict is the fallback.
        return null;
      }
    },
  };
}
