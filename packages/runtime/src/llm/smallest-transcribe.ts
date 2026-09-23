import { SMALLEST_TRANSCRIBE_MODEL } from '@waldo/contracts';
import type { Transcriber } from '../channels/telegram-media';

// Pulse pre-recorded STT takes raw bytes, including Telegram's OGG/Opus voice notes.
export const createSmallestTranscriber = (apiKey: string, language = 'en', fetcher: typeof fetch = fetch): Transcriber => async (audio) => {
  const params = new URLSearchParams({ model: SMALLEST_TRANSCRIBE_MODEL, language });
  const response = await fetcher(`https://api.smallest.ai/waves/v1/stt/?${params}`, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/octet-stream' }, body: audio,
  });
  const json = await response.json().catch(() => ({})) as { transcription?: string };
  if (!response.ok || typeof json.transcription !== 'string') throw new Error(`transcription failed: ${response.status}`);
  return json.transcription;
};
