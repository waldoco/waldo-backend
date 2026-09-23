import { describe, expect, it } from 'vitest';
import { ELEVENLABS_TRANSCRIBE_MODEL, SMALLEST_TRANSCRIBE_MODEL, WALDO_TRANSCRIBE_MODEL } from '@waldo/contracts';
import { createTelegramFileDownloader, loadTelegramMedia, toBase64 } from '../src/channels/telegram-media';
import { createOpenAITranscriber } from '../src/llm/openai-transcribe';
import { createSmallestTranscriber } from '../src/llm/smallest-transcribe';
import { createElevenLabsTranscriber } from '../src/llm/elevenlabs-transcribe';
import { selectTranscriber } from '../src/llm/transcriber';

const photo = { kind: 'photo' as const, fileId: 'big', fileName: null, mimeType: 'image/jpeg', fileSize: 3 };

describe('telegram media', () => {
  it('attaches a downloaded photo and notes it in the conversation text', async () => {
    const loaded = await loadTelegramMedia(photo, { download: async () => new Uint8Array([1, 2, 3]) });
    expect(loaded).toEqual({ note: '[Owner sent a photo, attached.]', attachment: { kind: 'image', mime_type: 'image/jpeg', filename: 'photo.jpg', data_base64: 'AQID' } });
  });

  it('reads supported documents by extension and explains the ones it cannot read', async () => {
    const bytes = async () => new Uint8Array([104, 105]);
    const pdf = await loadTelegramMedia({ kind: 'document', fileId: 'd', fileName: 'Plan.PDF', mimeType: null, fileSize: 2 }, { download: bytes });
    expect(pdf.attachment).toMatchObject({ kind: 'file', mime_type: 'application/pdf', filename: 'Plan.PDF' });
    const zip = await loadTelegramMedia({ kind: 'document', fileId: 'z', fileName: 'a.zip', mimeType: 'application/zip', fileSize: 2 }, { download: bytes });
    expect(zip).toEqual({ note: '[Owner sent a file "a.zip". This file type cannot be read yet.]' });
  });

  it('does not download oversized files and survives download failures', async () => {
    let called = false;
    const big = await loadTelegramMedia({ ...photo, fileSize: 21 * 1024 * 1024 }, { download: async () => { called = true; return new Uint8Array(); } });
    expect(called).toBe(false);
    expect(big.attachment).toBeUndefined();
    const failed = await loadTelegramMedia(photo, { download: async () => { throw new Error('down'); } });
    expect(failed).toEqual({ note: '[Owner sent a photo, but it could not be downloaded.]' });
  });

  it('resolves the file path with getFile before downloading', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return url.endsWith('/getFile')
        ? new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/f.jpg' } }))
        : new Response(new Uint8Array([7]));
    }) as unknown as typeof fetch;
    expect(await createTelegramFileDownloader('T', fetcher)('big')).toEqual(new Uint8Array([7]));
    expect(urls).toEqual(['https://api.telegram.org/botT/getFile', 'https://api.telegram.org/file/botT/photos/f.jpg']);
  });

  it('turns a voice note into a transcript note and never attaches audio', async () => {
    const voice = { kind: 'voice' as const, fileId: 'v', fileName: 'voice.ogg', mimeType: 'audio/ogg', fileSize: 10 };
    const seen: string[] = [];
    const heard = await loadTelegramMedia(voice, { download: async () => new Uint8Array([1]), transcribe: async (_audio, name, mime) => { seen.push(name, mime); return ' move gym to 7 '; } });
    expect(heard).toEqual({ note: '[Owner sent a voice note. Transcript: move gym to 7]' });
    expect(seen).toEqual(['voice.ogg', 'audio/ogg']);
    expect(await loadTelegramMedia(voice, { download: async () => new Uint8Array([1]), transcribe: async () => '  ' })).toEqual({ note: '[Owner sent a voice note with no speech that could be made out.]' });
    expect(await loadTelegramMedia(voice, { download: async () => new Uint8Array([1]), transcribe: async () => { throw new Error('403'); } })).toEqual({ note: '[Owner sent a voice note, but it could not be transcribed.]' });
    expect(await loadTelegramMedia(voice, { download: async () => new Uint8Array([1]) })).toEqual({ note: '[Owner sent a voice note, but voice reading is not set up here.]' });
  });

  it('posts audio to the transcription endpoint and surfaces failures without the key', async () => {
    let form: FormData | undefined;
    const ok = createOpenAITranscriber('sk-test', (async (_url: string, init: RequestInit) => { form = init.body as FormData; return new Response(JSON.stringify({ text: 'hi' })); }) as unknown as typeof fetch);
    expect(await ok(new Uint8Array([1]), 'voice.ogg', 'audio/ogg')).toBe('hi');
    expect(form?.get('model')).toBe(WALDO_TRANSCRIBE_MODEL);
    expect((form?.get('file') as unknown as File).name).toBe('voice.ogg');
    const denied = createOpenAITranscriber('sk-test', (async () => new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 403 })) as unknown as typeof fetch);
    await expect(denied(new Uint8Array([1]), 'voice.ogg', 'audio/ogg')).rejects.toThrow('transcription failed: 403 model_not_found');
  });

  it('sends raw audio bytes to smallest.ai Pulse and reads the transcription', async () => {
    let call: { url?: string; init?: RequestInit } = {};
    const pulse = createSmallestTranscriber('sm-test', 'en', (async (url: string, init: RequestInit) => { call = { url, init }; return new Response(JSON.stringify({ status: 'success', transcription: 'gym at 7' })); }) as unknown as typeof fetch);
    expect(await pulse(new Uint8Array([1, 2]), 'voice.ogg', 'audio/ogg')).toBe('gym at 7');
    expect(call.url).toBe(`https://api.smallest.ai/waves/v1/stt/?model=${SMALLEST_TRANSCRIBE_MODEL}&language=en`);
    expect(call.init?.headers).toEqual({ authorization: 'Bearer sm-test', 'content-type': 'application/octet-stream' });
    const denied = createSmallestTranscriber('sm-test', 'en', (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch);
    await expect(denied(new Uint8Array([1]), 'voice.ogg', 'audio/ogg')).rejects.toThrow('transcription failed: 401');
  });

  it('sends audio to ElevenLabs Scribe without pinning a language', async () => {
    let call: { url?: string; init?: RequestInit } = {};
    const scribe = createElevenLabsTranscriber('el-test', (async (url: string, init: RequestInit) => { call = { url, init }; return new Response(JSON.stringify({ language_code: 'hin', text: 'kal gym 7 baje' })); }) as unknown as typeof fetch);
    expect(await scribe(new Uint8Array([1]), 'voice.ogg', 'audio/ogg')).toBe('kal gym 7 baje');
    const form = call.init?.body as FormData;
    expect(call.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(call.init?.headers).toEqual({ 'xi-api-key': 'el-test' });
    expect(form.get('model_id')).toBe(ELEVENLABS_TRANSCRIBE_MODEL);
    expect(form.has('language_code')).toBe(false);
  });

  it('picks the first configured speech-to-text provider unless one is pinned', () => {
    expect(selectTranscriber({})).toBeUndefined();
    expect(selectTranscriber({ OPENAI_API_KEY: 'o' })?.provider).toBe('openai');
    expect(selectTranscriber({ OPENAI_API_KEY: 'o', SMALLEST_AI_API_KEY: 's' })?.provider).toBe('smallest');
    expect(selectTranscriber({ OPENAI_API_KEY: 'o', SMALLEST_AI_API_KEY: 's', ELEVENLABS_API_KEY: 'e' })?.provider).toBe('elevenlabs');
    expect(selectTranscriber({ OPENAI_API_KEY: 'o', SMALLEST_AI_API_KEY: 's', ELEVENLABS_API_KEY: 'e', WALDO_STT_PROVIDER: 'smallest' })?.provider).toBe('smallest');
    expect(selectTranscriber({ OPENAI_API_KEY: 'o', WALDO_STT_PROVIDER: 'elevenlabs' })).toBeUndefined();
  });

  it('encodes large buffers in chunks', () => {
    const bytes = new Uint8Array(100_000).fill(65);
    expect(atob(toBase64(bytes)).length).toBe(100_000);
  });
});
