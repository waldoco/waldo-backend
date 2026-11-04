import { WALDO_TRANSCRIBE_MODEL } from '@waldo/contracts';
import type { Transcriber } from '../channels/telegram-media';

export const createOpenAITranscriber = (apiKey: string, fetcher: typeof fetch = fetch): Transcriber => async (audio, filename, mimeType) => {
  const form = new FormData();
  form.append('model', WALDO_TRANSCRIBE_MODEL);
  form.append('file', new Blob([audio], { type: mimeType }), filename);
  const response = await fetcher('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form,
  });
  const json = await response.json() as { text?: string; error?: { code?: string } };
  if (!response.ok || typeof json.text !== 'string') throw new Error(`transcription failed: ${response.status} ${json.error?.code ?? ''}`.trim());
  return json.text;
};
