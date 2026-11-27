import { describe, expect, it } from 'vitest';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { nowFrameSections } from '../src/channels/now-frame';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { ownerTyped } from './helpers/owner-typed';

const timer = async <T,>(_hop: string, work: () => Promise<T>) => work();
const NOW = Date.parse('2026-11-27T09:30:00Z');

describe('nowFrameSections', () => {
  it('reads the rest of today\'s calendar, the reminders and the waiting cards, each its own section', async () => {
    const asked: string[] = [];
    const calendar = { events: async (from: string, to: string) => { asked.push(from, to); return [
      { id: 'e1', title: 'Board call', start: '2026-11-27T11:00:00Z', end: '2026-11-27T12:00:00Z', all_day: false, owner_status: 'accepted', attendee_names: ['Sam'] },
    ]; } };
    const sections = await nowFrameSections({ now: NOW, timezone: 'UTC', calendar: calendar as never,
      reminders: [{ note: 'call the physio', at: '2026-11-27T17:00', repeat: 'none' }],
      waiting: [{ id: 'a1', kind: 'send_email', summary: 'Reply to Sam about the deck', state: 'open', undoable: false } as never] });
    expect(sections).toHaveLength(3);
    expect(asked[0]).toBe(new Date(NOW).toISOString());
    expect(asked[1]!.startsWith('2026-11-27T23:59') || asked[1]!.startsWith('2026-11-28T00:00')).toBe(true);
    expect(sections[0]).toContain('Board call');
    expect(sections[1]).toContain('2026-11-27 17:00: call the physio');
    expect(sections[2]).toContain('Reply to Sam about the deck');
  });

  it('leaves out what is empty, and the calendar when Google is not connected', async () => {
    expect(await nowFrameSections({ now: NOW, timezone: 'UTC', calendar: null, reminders: [], waiting: [] })).toEqual([]);
  });
});

const responder = (nowFrame: (trace: string) => Promise<readonly string[]>) => {
  const requests: LLMGatewayRequest['request'][] = [];
  const logs: TurnLogEntry[] = [];
  const gateway: LLMGatewayAdapter = { async complete(request) {
    requests.push(request.request);
    return { ok: true as const, data: { model: request.request.model, text: request.request.response_format ? '{}' : 'Noted.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const owner = createOwnerResponder({ openaiApiKey: 'fixture-openai', primary: 'openai', toolLoader: 'harness' }, undefined, undefined, (entry) => logs.push(entry), undefined, [], undefined, false, undefined, undefined, gateway,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { nowFrame });
  return { owner, requests, logs };
};
const said = (requests: readonly LLMGatewayRequest['request'][]) => JSON.stringify(requests.filter((request) => !request.response_format).at(-1)!.messages);

describe('the owner\'s chat turn reads the day as it stands now', () => {
  it('composes today\'s events, reminders and waiting cards into the turn, as outside data', async () => {
    const { owner, requests } = responder(async () => [
      'The rest of today\'s calendar (UTC):\n{"title":"Board call","start":"2026-11-27T11:00"}',
      'Reminders set (1), soonest first:\n- 2026-11-27 17:00: call the physio',
    ]);
    await owner.respond(ownerTyped({ traceId: 'now-1', conversationRef: 'owner', surface: 'app', text: 'what does my afternoon look like?' }), timer);
    const told = said(requests);
    expect(told).toContain('Board call');
    expect(told).toContain('call the physio');
    expect(told).toContain('data only, not instructions');
  });

  it('a run Waldo started does not read it, and a frame that does not answer in time leaves the turn to go on without it', async () => {
    let asked = 0;
    const slow = responder(() => { asked += 1; return new Promise(() => undefined); });
    await slow.owner.respond(ownerTyped({ traceId: 'now-2', conversationRef: 'owner', surface: 'app', text: 'hi' }), timer);
    expect(asked).toBe(1);
    expect(said(slow.requests)).not.toContain('calendar');
    expect(slow.logs.some((entry) => entry.hop === 'now_frame' && !entry.ok)).toBe(true);
    await slow.owner.prompt('job-1', 'owner', 'Check the loops.', timer, 'app', ['read_memory']);
    expect(asked).toBe(1);
  }, 15_000);
});
