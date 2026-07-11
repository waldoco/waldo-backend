// Mutating tool arg schemas (ADR-0021; execute_code ADR-0023; destination ADR-0025; drafts
// ADR-0027). Invariants under test: strictObject arg boundaries, single-owner vocabulary
// reuse (channel, doc provider, hall — identity-asserted, not re-declared), mandatory
// `reasoning` on task mutations, 'r2_scratch' as the one representation of scratch space,
// and the ADR-0023 sandbox caps. Failure mode caught: a mutating tool's arg surface
// silently widening — extra keys, minted vocabulary, loosened caps — past the autonomy gate.
import { describe, expect, it } from 'vitest';
import { channelNameSchema } from '../../adapters/channel';
import { docProviderSchema } from '../../adapters/doc';
import { MEMORY_BLOCK_CONTENT_MAX } from '../../memory/sanitise';
import {
  draftDocumentArgsSchema,
  draftEmailArgsSchema,
  executeCodeArgsSchema,
  formZonePreferenceSchema,
  memoryWriteHallSchema,
  proposeActionArgsSchema,
  proposeScheduleArgsSchema,
  sendMessageArgsSchema,
  sheetWriteModeSchema,
  taskPrioritySchema,
  taskStatusSchema,
  updateMemoryArgsSchema,
  updateTaskArgsSchema,
  writeSheetCellArgsSchema,
  writeTaskArgsSchema,
} from './writes';

const key = 'a'.repeat(64);

describe('memoryWriteHall', () => {
  it('is exactly the four agent-writable halls, in order', () => {
    expect(memoryWriteHallSchema.options).toEqual([
      'events',
      'discoveries',
      'preferences',
      'advice',
    ]);
  });

  it('rejects the facts hall — not agent-writable', () => {
    expect(memoryWriteHallSchema.safeParse('facts').success).toBe(false);
  });
});

describe('updateMemoryArgs', () => {
  const base = { hall: 'events', content: 'user prefers morning workouts' } as const;

  it('accepts a minimal write and one with tags', () => {
    expect(updateMemoryArgsSchema.safeParse(base).success).toBe(true);
    expect(updateMemoryArgsSchema.safeParse({ ...base, tags: ['routine'] }).success).toBe(true);
  });

  it('accepts the memory block cap and rejects one char over', () => {
    expect(
      updateMemoryArgsSchema.safeParse({
        ...base,
        content: 'x'.repeat(MEMORY_BLOCK_CONTENT_MAX),
      }).success,
    ).toBe(true);
    expect(
      updateMemoryArgsSchema.safeParse({
        ...base,
        content: 'x'.repeat(MEMORY_BLOCK_CONTENT_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects more than 10 tags', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(updateMemoryArgsSchema.safeParse({ ...base, tags }).success).toBe(false);
  });

  it('rejects an unknown extra key (strictObject)', () => {
    expect(updateMemoryArgsSchema.safeParse({ ...base, hall_type: 'events' }).success).toBe(false);
  });
});

describe('proposeActionArgs', () => {
  const base = {
    action_type: 'reschedule_meeting',
    description: 'move the 3pm sync out of the recovery window',
    reasoning: 'recovery window collides with the sync',
  } as const;

  it('urgency is exactly low/medium/high, in order', () => {
    expect(proposeActionArgsSchema.shape.urgency.unwrap().options).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('defaults urgency to medium', () => {
    expect(proposeActionArgsSchema.parse(base).urgency).toBe('medium');
  });

  it('rejects an out-of-domain urgency', () => {
    expect(proposeActionArgsSchema.safeParse({ ...base, urgency: 'critical' }).success).toBe(false);
  });

  it('rejects a missing reasoning — mandatory audit surface', () => {
    const { reasoning: _reasoning, ...rest } = base;
    expect(proposeActionArgsSchema.safeParse(rest).success).toBe(false);
  });
});

describe('sendMessageArgs', () => {
  const base = {
    channel: 'telegram',
    content: 'nudge: recovery window starts in 20 min',
    idempotency_key: key,
  } as const;

  it('reuses the channel single owner — imported, never re-declared', () => {
    expect(sendMessageArgsSchema.shape.channel).toBe(channelNameSchema);
  });

  it('accepts every canonical channel, including discord', () => {
    expect(sendMessageArgsSchema.safeParse(base).success).toBe(true);
    expect(sendMessageArgsSchema.safeParse({ ...base, channel: 'discord' }).success).toBe(true);
  });

  it('rejects a non-canonical channel', () => {
    expect(sendMessageArgsSchema.safeParse({ ...base, channel: 'sms' }).success).toBe(false);
  });

  it('rejects a missing idempotency_key — delivery is exactly-once', () => {
    const { idempotency_key: _ik, ...rest } = base;
    expect(sendMessageArgsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-64-hex idempotency_key', () => {
    expect(sendMessageArgsSchema.safeParse({ ...base, idempotency_key: 'retry-1' }).success).toBe(
      false,
    );
  });

  it('accepts content at 4096 chars and rejects 4097', () => {
    expect(sendMessageArgsSchema.safeParse({ ...base, content: 'x'.repeat(4_096) }).success).toBe(
      true,
    );
    expect(sendMessageArgsSchema.safeParse({ ...base, content: 'x'.repeat(4_097) }).success).toBe(
      false,
    );
  });

  it('rejects a model-supplied user_id (identity comes from trusted context)', () => {
    expect(sendMessageArgsSchema.safeParse({ ...base, user_id: 'user-1' }).success).toBe(false);
  });
});

describe('taskPriority', () => {
  it('is exactly low/medium/high, in order', () => {
    expect(taskPrioritySchema.options).toEqual(['low', 'medium', 'high']);
  });
});

describe('writeTaskArgs', () => {
  const base = { title: 'prep board deck', reasoning: 'user asked during the 9am brief' } as const;

  it('accepts a minimal task and a fully-specified one', () => {
    expect(writeTaskArgsSchema.safeParse(base).success).toBe(true);
    expect(
      writeTaskArgsSchema.safeParse({
        ...base,
        due: '2030-01-05T09:00:00Z',
        priority: 'high',
        tags: ['board'],
        parent_task_id: 'task-9',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing reasoning — mandatory audit surface', () => {
    expect(writeTaskArgsSchema.safeParse({ title: base.title }).success).toBe(false);
  });

  it('rejects a non-ISO-8601 due', () => {
    expect(writeTaskArgsSchema.safeParse({ ...base, due: 'next tuesday' }).success).toBe(false);
  });

  it('rejects a title over 200 chars', () => {
    expect(writeTaskArgsSchema.safeParse({ ...base, title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('rejects a description-shaped extra key — titles only cross the privacy wall', () => {
    expect(writeTaskArgsSchema.safeParse({ ...base, description: 'notes' }).success).toBe(false);
  });
});

describe('taskStatus', () => {
  it('is exactly the four mutation statuses, in order', () => {
    expect(taskStatusSchema.options).toEqual(['todo', 'in_progress', 'done', 'cancelled']);
  });
});

describe('updateTaskArgs', () => {
  const base = {
    task_id: 'task-1',
    changes: { status: 'cancelled' },
    reasoning: 'meeting moved, task obsolete',
  } as const;

  it('accepts a status change to cancelled', () => {
    expect(updateTaskArgsSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an out-of-domain status', () => {
    expect(
      updateTaskArgsSchema.safeParse({ ...base, changes: { status: 'archived' } }).success,
    ).toBe(false);
  });

  it('rejects an unknown key inside changes (nested strictObject)', () => {
    expect(
      updateTaskArgsSchema.safeParse({ ...base, changes: { assignee: 'rohan' } }).success,
    ).toBe(false);
  });

  it('rejects a missing reasoning — mandatory audit surface', () => {
    const { reasoning: _reasoning, ...rest } = base;
    expect(updateTaskArgsSchema.safeParse(rest).success).toBe(false);
  });
});

describe('draftDocumentArgs', () => {
  const base = { title: 'weekly plan', body_markdown: '# Plan', destination: 'r2_scratch' } as const;

  it('reuses the DocProvider single owner — imported, never re-declared', () => {
    expect(draftDocumentArgsSchema.shape.destination).toBe(docProviderSchema);
  });

  it("accepts destination 'r2_scratch' and external providers", () => {
    expect(draftDocumentArgsSchema.safeParse(base).success).toBe(true);
    expect(draftDocumentArgsSchema.safeParse({ ...base, destination: 'notion' }).success).toBe(
      true,
    );
  });

  it("rejects bare 'scratch' — one concept, one representation", () => {
    expect(draftDocumentArgsSchema.safeParse({ ...base, destination: 'scratch' }).success).toBe(
      false,
    );
  });

  it('defaults shareable to false', () => {
    expect(draftDocumentArgsSchema.parse(base).shareable).toBe(false);
  });

  it('rejects body_markdown over the 50_000-char cap', () => {
    expect(
      draftDocumentArgsSchema.safeParse({ ...base, body_markdown: 'x'.repeat(50_001) }).success,
    ).toBe(false);
  });

  it('rejects an unknown extra key (strictObject)', () => {
    expect(draftDocumentArgsSchema.safeParse({ ...base, publish: true }).success).toBe(false);
  });
});

describe('draftEmailArgs', () => {
  const base = {
    to: ['sam@example.com'],
    subject: 'boundary for Thursday',
    body_markdown: 'Hi Sam,',
  } as const;

  it('accepts a minimal draft and one with cc and thread continuation', () => {
    expect(draftEmailArgsSchema.safeParse(base).success).toBe(true);
    expect(
      draftEmailArgsSchema.safeParse({
        ...base,
        cc: ['ops@example.com'],
        reply_to_thread_id: 'thread-1',
        in_reply_to_msg_id: 'msg-1',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty recipient list', () => {
    expect(draftEmailArgsSchema.safeParse({ ...base, to: [] }).success).toBe(false);
  });

  it('rejects 51 recipients', () => {
    const to = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
    expect(draftEmailArgsSchema.safeParse({ ...base, to }).success).toBe(false);
  });

  it('rejects a malformed address — bare emails only at the tool seam', () => {
    expect(
      draftEmailArgsSchema.safeParse({ ...base, to: ['Sam <sam@example.com>'] }).success,
    ).toBe(false);
  });

  it('accepts a body at 10_000 chars and rejects 10_001 (sanitiser size cap)', () => {
    expect(
      draftEmailArgsSchema.safeParse({ ...base, body_markdown: 'x'.repeat(10_000) }).success,
    ).toBe(true);
    expect(
      draftEmailArgsSchema.safeParse({ ...base, body_markdown: 'x'.repeat(10_001) }).success,
    ).toBe(false);
  });

  it('rejects a send-shaped extra key — drafts only, never sends', () => {
    expect(draftEmailArgsSchema.safeParse({ ...base, send: true }).success).toBe(false);
  });
});

describe('formZonePreference', () => {
  it('is exactly energized/steady/avoid_trough, in order', () => {
    expect(formZonePreferenceSchema.options).toEqual(['energized', 'steady', 'avoid_trough']);
  });

  it("rejects 'peak' — a load-zone word, not a form zone", () => {
    expect(formZonePreferenceSchema.safeParse('peak').success).toBe(false);
  });
});

describe('proposeScheduleArgs', () => {
  const base = {
    attendees: ['sam@example.com'],
    duration_min: 30,
    title: 'strategy sync',
  } as const;

  it('accepts a minimal proposal and a fully-specified one', () => {
    expect(proposeScheduleArgsSchema.safeParse(base).success).toBe(true);
    expect(
      proposeScheduleArgsSchema.safeParse({
        ...base,
        description_markdown: 'agenda',
        earliest: '2030-01-05T09:00:00Z',
        latest: '2030-01-05T18:00:00Z',
        prefer_user_form_zone: 'energized',
      }).success,
    ).toBe(true);
  });

  it('accepts the 15 and 480 minute bounds and rejects outside them', () => {
    expect(proposeScheduleArgsSchema.safeParse({ ...base, duration_min: 15 }).success).toBe(true);
    expect(proposeScheduleArgsSchema.safeParse({ ...base, duration_min: 480 }).success).toBe(true);
    expect(proposeScheduleArgsSchema.safeParse({ ...base, duration_min: 10 }).success).toBe(false);
    expect(proposeScheduleArgsSchema.safeParse({ ...base, duration_min: 500 }).success).toBe(false);
  });

  it('rejects an empty attendee list and a malformed address', () => {
    expect(proposeScheduleArgsSchema.safeParse({ ...base, attendees: [] }).success).toBe(false);
    expect(proposeScheduleArgsSchema.safeParse({ ...base, attendees: ['sam'] }).success).toBe(
      false,
    );
  });

  it("rejects prefer_user_form_zone 'peak'", () => {
    expect(
      proposeScheduleArgsSchema.safeParse({ ...base, prefer_user_form_zone: 'peak' }).success,
    ).toBe(false);
  });
});

describe('sheetWriteMode', () => {
  it('is exactly overwrite/append, in order', () => {
    expect(sheetWriteModeSchema.options).toEqual(['overwrite', 'append']);
  });
});

describe('writeSheetCellArgs', () => {
  const base = { sheet_id: 'sheet-1', range: 'Sheet1!A5', value: 'Q3' } as const;

  it('accepts string and numeric values', () => {
    expect(writeSheetCellArgsSchema.safeParse(base).success).toBe(true);
    expect(writeSheetCellArgsSchema.safeParse({ ...base, value: 12 }).success).toBe(true);
  });

  it('rejects a boolean value', () => {
    expect(writeSheetCellArgsSchema.safeParse({ ...base, value: true }).success).toBe(false);
  });

  it('defaults mode to overwrite', () => {
    expect(writeSheetCellArgsSchema.parse(base).mode).toBe('overwrite');
  });

  it('rejects a range over 100 chars', () => {
    expect(writeSheetCellArgsSchema.safeParse({ ...base, range: 'x'.repeat(101) }).success).toBe(
      false,
    );
  });
});

describe('executeCodeArgs', () => {
  const base = { language: 'python', code: 'print(1)' } as const;

  it('language is exactly python/js, in order', () => {
    expect(executeCodeArgsSchema.shape.language.options).toEqual(['python', 'js']);
  });

  it('defaults to a closed sandbox: empty egress, 30_000 ms, 256 MB', () => {
    const parsed = executeCodeArgsSchema.parse(base);
    expect(parsed.allow_hosts).toEqual([]);
    expect(parsed.timeout_ms).toBe(30_000);
    expect(parsed.memory_mb).toBe(256);
  });

  it('rejects a timeout over the 30_000 ms hard cap', () => {
    expect(executeCodeArgsSchema.safeParse({ ...base, timeout_ms: 30_001 }).success).toBe(false);
  });

  it('rejects memory below the 64 MB floor', () => {
    expect(executeCodeArgsSchema.safeParse({ ...base, memory_mb: 32 }).success).toBe(false);
  });

  it('rejects an out-of-domain language', () => {
    expect(executeCodeArgsSchema.safeParse({ ...base, language: 'ruby' }).success).toBe(false);
  });

  it('rejects more than 20 allow_hosts', () => {
    const allow_hosts = Array.from({ length: 21 }, (_, i) => `h${i}.example.com`);
    expect(executeCodeArgsSchema.safeParse({ ...base, allow_hosts }).success).toBe(false);
  });

  it('rejects empty code', () => {
    expect(executeCodeArgsSchema.safeParse({ ...base, code: '' }).success).toBe(false);
  });
});
