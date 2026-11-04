import { ELEVENLABS_TRANSCRIBE_MODEL } from '@waldo/contracts';
import type { Transcriber } from '../channels/telegram-media';

// No language_code: Scribe detects the language, which keeps Hindi-English code-switching intact.
export const createElevenLabsTranscriber = (apiKey: string, fetcher: typeof fetch = fetch): Transcriber => async (audio, filename, mimeType) => {
  const form = new FormData();
  form.append('model_id', ELEVENLABS_TRANSCRIBE_MODEL);
  form.append('file', new Blob([audio], { type: mimeType }), filename);
  const response = await fetcher('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form });
  const json = await response.json().catch(() => ({})) as { text?: string };
  if (!response.ok || typeof json.text !== 'string') throw new Error(`transcription failed: ${response.status}`);
  return json.text;
};
