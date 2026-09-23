import type { Transcriber } from '../channels/telegram-media';
import { createElevenLabsTranscriber } from './elevenlabs-transcribe';
import { createOpenAITranscriber } from './openai-transcribe';
import { createSmallestTranscriber } from './smallest-transcribe';

export type TranscriberEnv = Readonly<{
  WALDO_STT_PROVIDER?: string;
  ELEVENLABS_API_KEY?: string;
  SMALLEST_AI_API_KEY?: string;
  OPENAI_API_KEY?: string;
}>;

type Provider = 'elevenlabs' | 'smallest' | 'openai';
const ORDER: readonly Provider[] = ['elevenlabs', 'smallest', 'openai'];

const build = (provider: Provider, env: TranscriberEnv): Transcriber | undefined => {
  if (provider === 'elevenlabs') return env.ELEVENLABS_API_KEY ? createElevenLabsTranscriber(env.ELEVENLABS_API_KEY) : undefined;
  if (provider === 'smallest') return env.SMALLEST_AI_API_KEY ? createSmallestTranscriber(env.SMALLEST_AI_API_KEY) : undefined;
  return env.OPENAI_API_KEY ? createOpenAITranscriber(env.OPENAI_API_KEY) : undefined;
};

// WALDO_STT_PROVIDER pins a provider; otherwise the first provider with a key wins.
export const selectTranscriber = (env: TranscriberEnv): Readonly<{ provider: Provider; transcribe: Transcriber }> | undefined => {
  const pinned = ORDER.find((provider) => provider === env.WALDO_STT_PROVIDER);
  for (const provider of pinned ? [pinned] : ORDER) {
    const transcribe = build(provider, env);
    if (transcribe) return { provider, transcribe };
  }
  return undefined;
};
