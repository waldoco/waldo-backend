import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryCalendarArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type ConversationEntry } from '@waldo/contracts';
import type { TelegramMedia } from '../src/channels/telegram-polling';

const model = vi.hoisted(() => ({ requests: [] as unknown[], queryCalendar: true }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: unknown) => {
    model.requests.push(body);
    const query = model.queryCalendar && !JSON.stringify(body).includes('function_call_output');
    return {
      id: `media-response-${model.requests.length}`, output_text: query ? '' : 'Calendar checked.',
      output: query ? [{ type: 'function_call', call_id: 'media-calendar', name: 'query_calendar', arguments: '{}' }] : [],
      usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    };
  } };
} }));

const { createTelegramResponder } = await import('../src/channels/telegram-turn');
const time = <T>(_hop: string, work: () => Promise<T>) => work();
const cases: readonly { name: string; media: TelegramMedia; text: string; note: string; image: boolean }[] = [
  { name: 'downloaded photo', media: { kind: 'photo', fileId: 'photo-fixture', fileName: null, mimeType: 'image/jpeg', fileSize: 3 }, text: "What's on my calendar?", note: '[Owner sent a photo, attached.]', image: true },
  { name: 'attachment note without readable bytes', media: { kind: 'document', fileId: 'archive-fixture', fileName: 'notes.zip', mimeType: 'application/zip', fileSize: 3 }, text: "What's on my calendar?", note: '[Owner sent a file "notes.zip". This file type cannot be read yet.]', image: false },
  { name: 'voice-only calendar request', media: { kind: 'voice', fileId: 'voice-fixture', fileName: 'voice.ogg', mimeType: 'audio/ogg', fileSize: 3 }, text: '', note: "[Owner sent a voice note. Transcript: What's on my calendar?]", image: false },
];

beforeEach(() => { model.requests = []; model.queryCalendar = true; });

describe('media-scope: media and voice retain tools and conversation history', () => {
  for (const surface of ['telegram', 'whatsapp']) {
    it.each(cases)(`${surface}: $name executes calendar without source-scope admission`, async ({ media, text, note, image }) => {
      const priorOwner = 'Please keep the earlier discussion about the design review in mind.';
      const priorReply = 'We discussed the design review agenda.';
      const entries: ConversationEntry[] = [
        { id: 'prior-owner', ownerId: 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chatId: `${surface}-7`, parentId: null, threadAnchorId: null, surface, role: 'user', modelPayload: priorOwner, appPayload: priorOwner, modelProjection: { mode: 'include' } },
        { id: 'prior-reply', ownerId: 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chatId: `${surface}-7`, parentId: 'prior-owner', threadAnchorId: null, surface, role: 'assistant', modelPayload: priorReply, appPayload: priorReply, modelProjection: { mode: 'include' } },
      ];
      let leafId = 'prior-reply';
      const calendar = vi.fn(async () => ({ ok: true as const, data: { events: [{ title: 'Design review', starts_at: '2026-10-08T15:00:00+05:30' }] }, source_taint: 'external' as const }));
      const args: Parameters<typeof createTelegramResponder> = ['fixture-key', {
        load: async () => ({ entries: [...entries], leafId }),
        save: async (rows, leaf) => { entries.push(...rows); leafId = leaf; },
      }];
      args[4] = { download: vi.fn(async () => new Uint8Array([1, 2, 3])), transcribe: vi.fn(async () => "What's on my calendar?") };
      args[6] = [{ name: 'query_calendar', description: 'Read the fixture calendar', schema: queryCalendarArgsSchema, autonomy_gated: false, requires_connector: true, trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('query_calendar')), handle: calendar }];
      args[20] = surface;
      // Media turns are prepared like any other turn.
      const prepare = vi.fn(async () => undefined);
      args[21] = { prepare };
      const responder = createTelegramResponder(...args);
      const turn = { updateId: 12, messageId: 12, senderId: 7, chatId: 7, sentAt: null, text, media, runScope: {
        runId: 'media-run', attempt: 'media-attempt', deadline: Date.now() + 150_000, signal: new AbortController().signal,
        admit: () => undefined, commit: <T>(work: () => T) => work(),
      } };

      expect(await responder.respond(turn, time)).toBe('Calendar checked.');
      expect(calendar).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(model.requests).toHaveLength(2);
      for (const request of model.requests) {
        const body = JSON.stringify(request);
        expect(body).toContain(priorOwner);
        expect(body).toContain(priorReply);
        expect(body).toContain(note.replaceAll('"', '\\"'));
        expect(body).toContain('query_calendar');
        expect(body).not.toContain('Current owner task source scope is unavailable');
        expect(body).not.toContain('propose_task_sources');
      }
      expect(JSON.stringify(model.requests[1])).toContain('Design review');
      expect(JSON.stringify(model.requests[1])).toContain('"ok":true'.replaceAll('"', '\\"'));
      expect(JSON.stringify(model.requests[0]).includes('data:image/jpeg;base64,AQID')).toBe(image);
      const saved = entries.find(entry => entry.id === (surface === 'telegram' ? 'tg-12' : 'whatsapp-12'))!;
      expect(saved).toMatchObject({ chatId: `${surface}-7`, surface, modelPayload: [text, note].filter(Boolean).join('\n'), appPayload: [text, note].filter(Boolean).join('\n') });
      expect(JSON.stringify(entries)).not.toContain('AQID');

      // Recreate the responder to prove the note and earlier conversation survive a store reload.
      model.requests = [];
      model.queryCalendar = false;
      const restored = createTelegramResponder(...args);
      await restored.respond({ ...turn, updateId: 13, messageId: 13, text: 'Thanks for checking.', media: undefined }, time);
      expect(model.requests).toHaveLength(1);
      const next = JSON.stringify(model.requests[0]);
      expect(next).toContain(priorOwner);
      expect(next).toContain(priorReply);
      expect(next).toContain(note.replaceAll('"', '\\"'));
      expect(next).not.toContain('data:image/jpeg;base64,AQID');
      expect(calendar).toHaveBeenCalledTimes(1);
    });
  }
});
