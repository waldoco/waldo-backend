import { describe, expect, it } from 'vitest';
import {
  APP_THREAD_MAX_V1, appThreadArchiveV1Schema, appThreadCreateV1Schema, appThreadDeleteV1Schema, appThreadListQueryV1Schema, appThreadListV1Schema,
  appThreadOperationResultV1Schema, appThreadReadQueryV1Schema, appThreadReadV1Schema, appThreadRenameV1Schema, appThreadRoutesV1, appThreadSendV1Schema, appThreadV1Schema,
} from './threads';

const thread_id = 'thr_3f2c8a10-4b7d-4c1e-9a2b-1234567890ab', operation_id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const thread = { thread_id, title: null, preview: null, revision: 1, title_revision: 1, state: 'active', created_at: 1_791_700_000_000, last_activity_at: 1_791_700_000_000 };

describe('threads', () => {
  it('reads an untitled or titled thread with separate revisions and times', () => {
    for (const valid of [thread, { ...thread, title: 'Lisbon trip', title_revision: 2, preview: 'Flights are cheaper on Tuesday.' }, { ...thread, state: 'archived', revision: 3, preview: 'x'.repeat(280) }])
      expect(appThreadV1Schema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...thread, title: '' }, { ...thread, title: 'x'.repeat(201) }, { ...thread, title_revision: 0 }, { ...thread, revision: 1.5 },
      { ...thread, updated_at: 1 }, { ...thread, conversation_ref: 'owner:prn_x:thread:y' }, { ...thread, state: 'paused' },
      { ...thread, thread_id: 'thr_not-a-uuid' }, { ...thread, last_activity_at: -1 }, (({ last_activity_at: _l, ...rest }) => rest)(thread),
      { ...thread, preview: '' }, { ...thread, preview: 'x'.repeat(281) }, (({ preview: _p, ...rest }) => rest)(thread),
    ]) expect(appThreadV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('creates with or without a title, and renames on the title revision only', () => {
    expect(appThreadCreateV1Schema.safeParse({ operation_id }).success).toBe(true);
    expect(appThreadCreateV1Schema.safeParse({ operation_id, title: '  Lisbon trip ' }).data?.title).toBe('Lisbon trip');
    expect(appThreadRenameV1Schema.safeParse({ operation_id, expected_title_revision: 1, title: 'Training' }).success).toBe(true);
    for (const invalid of [{ operation_id, title: '   ' }, { operation_id: 'op-1', title: 'x' }, { operation_id, title: 'x', expected_revision: 1 }])
      expect(appThreadCreateV1Schema.safeParse(invalid).success).toBe(false);
    for (const invalid of [{ operation_id, expected_revision: 1, title: 'x' }, { operation_id, expected_title_revision: 1 }, { operation_id, expected_title_revision: 0, title: 'x' }])
      expect(appThreadRenameV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('archives, unarchives and deletes against the turn revision', () => {
    for (const archived of [true, false]) expect(appThreadArchiveV1Schema.safeParse({ operation_id, expected_revision: 2, archived }).success).toBe(true);
    expect(appThreadDeleteV1Schema.safeParse({ operation_id, expected_revision: 2 }).success).toBe(true);
    expect(appThreadArchiveV1Schema.safeParse({ operation_id, expected_revision: 2 }).success).toBe(false);
    expect(appThreadDeleteV1Schema.safeParse({ operation_id, expected_revision: 2, confirmation: 'DELETE' }).success).toBe(false);
  });

  it('records operations, including erasure counts and the deleted state', () => {
    const result = { operation_id, state: 'recorded', thread_id, revision: 2, title_revision: 1, thread_state: 'deleted', erased_messages: 4 };
    expect(appThreadOperationResultV1Schema.safeParse(result).success).toBe(true);
    for (const invalid of [{ ...result, state: 'pending' }, { ...result, erased_messages: -1 }, (({ title_revision: _t, ...rest }) => rest)(result)])
      expect(appThreadOperationResultV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('lists every live thread in one bounded page', () => {
    expect(appThreadListV1Schema.safeParse({ threads: [thread] }).success).toBe(true);
    expect(appThreadListV1Schema.safeParse({ threads: Array.from({ length: APP_THREAD_MAX_V1 + 1 }, () => thread) }).success).toBe(false);
    expect(appThreadListV1Schema.safeParse({ threads: [], next_cursor: null }).success).toBe(false);
    for (const query of [{}, { state: 'archived' }, { state: 'all' }]) expect(appThreadListQueryV1Schema.safeParse(query).success).toBe(true);
    for (const query of [{ state: 'deleted' }, { cursor: '1' }]) expect(appThreadListQueryV1Schema.safeParse(query).success).toBe(false);
  });

  it('reads a thread with its history page', () => {
    expect(appThreadReadV1Schema.safeParse({ thread, history: { messages: [], next_cursor: null } }).success).toBe(true);
    expect(appThreadReadV1Schema.safeParse({ thread, history: { messages: [] } }).success).toBe(false);
    expect(appThreadReadQueryV1Schema.safeParse({ cursor: 'before:entry-1', limit: '20' }).success).toBe(true);
    for (const query of [{ limit: '51' }, { cursor: 'after:entry-1' }]) expect(appThreadReadQueryV1Schema.safeParse(query).success).toBe(false);
  });

  it('sends as main does, plus the turn revision; no context or attachment references yet', () => {
    const send = { client_message_id: 'client-0001', text: 'Plan the Lisbon trip', expected_revision: 1 };
    expect(appThreadSendV1Schema.safeParse(send).success).toBe(true);
    for (const invalid of [
      { ...send, expected_revision: 0 }, (({ expected_revision: _e, ...rest }) => rest)(send), { ...send, client_message_id: 'short' },
      { ...send, context_refs: [] }, { ...send, attachment_refs: [] }, { ...send, voice: {} },
    ]) expect(appThreadSendV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('names the subset routes only', () => {
    expect(appThreadRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /app/v1/threads', 'POST /app/v1/threads', 'GET /app/v1/threads/operations/{operation_id}', 'GET /app/v1/threads/{thread_id}',
      'POST /app/v1/threads/{thread_id}/rename', 'POST /app/v1/threads/{thread_id}/archive', 'POST /app/v1/threads/{thread_id}/delete',
      'POST /app/v1/threads/{thread_id}/messages', 'GET /app/v1/threads/{thread_id}/messages/{client_message_id}',
      'POST /app/v1/threads/{thread_id}/messages/{client_message_id}/cancel', 'PUT /app/v1/threads/{thread_id}/messages/{message_id}/rating',
    ]);
  });
});
