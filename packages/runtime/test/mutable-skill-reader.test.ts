import { skillRowSchema, type CanaryTokens, type SkillRow } from '@waldo/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  MutableSkillReader,
  type MutableSkillDescriptor,
  type MutableSkillHead,
  type MutableSkillReadSource,
  type MutableSkillStream,
} from '../src/skills/mutable-reader';
import * as scribe from '../src/scribe/prepare';

const CANARIES: CanaryTokens = [
  '1111111111111111',
  '2222222222222222',
  '3333333333333333',
];

const encoder = new TextEncoder();

function trustedRow(overrides: Partial<SkillRow> = {}): SkillRow {
  return skillRowSchema.parse({
    name: 'calm-brief',
    version: 1,
    provenance: 'user',
    identity_locked: false,
    provisional: false,
    trigger_types: ['brief'],
    trigger_condition: 'A brief is scheduled.',
    required_tools: [],
    required_connectors: [],
    effectiveness: 0.8,
    invocations: 0,
    last_used: null,
    body_markdown: 'Trusted record content is ignored by the reader.',
    created_at: '2026-07-12T00:00:00Z',
    created_by: 'fixture',
    status: 'active',
    pinned: false,
    last_curated_at: null,
    archived_at: null,
    ...overrides,
  });
}

function frontmatter(
  row: SkillRow,
  body = 'A calm reminder supports the planned brief.',
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  const evidence = {
    name: row.name,
    version: row.version,
    provenance: row.provenance,
    identity_locked: row.identity_locked,
    provisional: row.provisional,
    trigger_types: row.trigger_types,
    trigger_condition: row.trigger_condition,
    required_tools: row.required_tools,
    required_connectors: row.required_connectors,
    effectiveness: row.effectiveness,
    invocations: row.invocations,
    last_used: row.last_used,
    created_at: row.created_at,
    ...overrides,
  };

  return `---\n${Object.entries(evidence)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')}\n---\n${body}`;
}

function rawFrontmatter(lines: readonly string[], body = 'A calm reminder supports the planned brief.'): string {
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

function headerLines(row: SkillRow): string[] {
  return frontmatter(row).split('\n').slice(1, -2);
}

function frontmatterHeaderBytes(text: string): number {
  const closing = text.indexOf('\n---\n', 4);
  if (closing < 0) throw new Error('fixture frontmatter must close');
  return encoder.encode(text.slice(0, closing + '\n---\n'.length)).byteLength;
}

function frontmatterAtHeaderBytes(target: number): Readonly<{ row: SkillRow; text: string }> {
  const required_tools = Array.from({ length: 32 }, () => 't');
  const make = () =>
    trustedRow({
      trigger_condition: 'c'.repeat(1_024),
      required_tools,
    });
  let row = make();
  let text = frontmatter(row);
  let remaining = target - frontmatterHeaderBytes(text);
  if (remaining < 0) throw new Error('fixture baseline exceeds the header target');

  for (let index = 0; index < required_tools.length && remaining > 0; index += 1) {
    const extra = Math.min(99, remaining);
    required_tools[index] = `${required_tools[index]}${'p'.repeat(extra)}`;
    remaining -= extra;
  }
  row = make();
  text = frontmatter(row);
  if (frontmatterHeaderBytes(text) !== target) throw new Error('fixture cannot reach header target');
  return { row, text };
}

class SingleLogicalSource implements MutableSkillReadSource {
  readonly validator = Symbol('fixture-version');
  readonly descriptor: MutableSkillDescriptor;
  readonly heads: MutableSkillHead[] = [];
  readonly opened: Array<{ rangeBytes: number }> = [];

  constructor(private readonly text: string) {
    this.descriptor = {
      name: 'calm-brief',
      byteLength: encoder.encode(text).byteLength,
      validator: this.validator,
    };
  }

  async list(limit: number) {
    expect(limit).toBe(17);
    return { descriptors: [this.descriptor], truncated: false };
  }

  async head(): Promise<MutableSkillHead> {
    const head = { byteLength: this.descriptor.byteLength, validator: this.validator };
    this.heads.push(head);
    return head;
  }

  async open(
    _descriptor: MutableSkillDescriptor,
    _head: MutableSkillHead,
    rangeBytes: number,
  ) {
    this.opened.push({ rangeBytes });
    const bytes = encoder.encode(this.text);
    return {
      validator: this.validator,
      chunks: (async function* () {
        yield bytes;
      })(),
    };
  }
}

type FixtureEntry = Readonly<{
  descriptor: MutableSkillDescriptor;
  head: MutableSkillHead | null;
  stream: MutableSkillStream | null;
}>;

class ObservedLogicalSource implements MutableSkillReadSource {
  readonly events: string[] = [];
  readonly openCalls: Array<Readonly<{ rangeBytes: number }>> = [];

  constructor(
    private readonly entries: readonly FixtureEntry[],
    private readonly listing: Readonly<{ descriptors: readonly MutableSkillDescriptor[]; truncated: boolean }> = {
      descriptors: entries.map((entry) => entry.descriptor),
      truncated: false,
    },
  ) {}

  async list(limit: number) {
    this.events.push(`list:${limit}`);
    return this.listing;
  }

  async head(descriptor: MutableSkillDescriptor): Promise<MutableSkillHead | null> {
    this.events.push('head');
    return this.entries.find((entry) => entry.descriptor.name === descriptor.name)?.head ?? null;
  }

  async open(
    descriptor: MutableSkillDescriptor,
    _expected: MutableSkillHead,
    rangeBytes: number,
  ): Promise<MutableSkillStream | null> {
    this.events.push('open');
    this.openCalls.push({ rangeBytes });
    return this.entries.find((entry) => entry.descriptor.name === descriptor.name)?.stream ?? null;
  }
}

function bytesStream(...chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function fixtureEntry(row: SkillRow, text = frontmatter(row)): FixtureEntry {
  const validator = Symbol('fixture-version');
  const bytes = encoder.encode(text);
  return {
    descriptor: { name: row.name, byteLength: bytes.byteLength, validator },
    head: { byteLength: bytes.byteLength, validator },
    stream: { validator, chunks: bytesStream(bytes) },
  };
}

function readerFor(source: MutableSkillReadSource, rows: readonly SkillRow[]): MutableSkillReader {
  return new MutableSkillReader({
    source,
    trustedRecords: {
      resolve: async (name) => rows.find((row) => row.name === name) ?? null,
    },
  });
}

describe('MutableSkillReader', () => {
  it('admits a complete trusted mutable skill only after bounded conditional reading', async () => {
    const row = trustedRow();
    const source = new SingleLogicalSource(frontmatter(row));
    const reader = new MutableSkillReader({
      source,
      trustedRecords: {
        resolve: async (name) => (name === row.name ? row : null),
      },
    });

    const result = await reader.load(CANARIES);

    expect(result).toEqual({
      ok: true,
      skills: [
        expect.objectContaining({
          name: row.name,
          provenance: 'user',
          body_markdown: 'A calm reminder supports the planned brief.',
        }),
      ],
    });
    expect(source.opened).toEqual([{ rangeBytes: 20 * 1024 + 1 }]);
  });

  it('rejects an over-20KiB declared object before opening, decoding, or caching it', async () => {
    const row = trustedRow();
    const entry = fixtureEntry(row);
    const source = new ObservedLogicalSource([
      {
        ...entry,
        head: { byteLength: 20 * 1024 + 1, validator: entry.head?.validator ?? Symbol('missing') },
      },
    ]);

    const result = await readerFor(source, [row]).load(CANARIES);

    expect(result).toEqual({ ok: false, failure: 'source_unavailable' });
    expect(source.openCalls).toEqual([]);
  });

  it('rejects a truncated, seventeenth, or duplicate logical descriptor before body admission', async () => {
    const row = trustedRow();
    const entry = fixtureEntry(row);
    const seventeen = Array.from({ length: 17 }, () => entry.descriptor);
    const cases = [
      { descriptors: [entry.descriptor], truncated: true },
      { descriptors: seventeen, truncated: false },
      { descriptors: [entry.descriptor, entry.descriptor], truncated: false },
    ] as const;

    for (const listing of cases) {
      const source = new ObservedLogicalSource([entry], listing);
      const result = await readerFor(source, [row]).load(CANARIES);

      expect(result).toEqual({ ok: false, failure: 'source_unavailable' });
      expect(source.openCalls).toEqual([]);
    }
  });

  it('heads every logical descriptor before opening the first conditional stream', async () => {
    const first = trustedRow();
    const second = trustedRow({ name: 'grounded-brief' });
    const source = new ObservedLogicalSource([fixtureEntry(first), fixtureEntry(second)]);

    const result = await readerFor(source, [first, second]).load(CANARIES);

    expect(result.ok).toBe(true);
    const firstOpen = source.events.indexOf('open');
    expect(firstOpen).toBeGreaterThanOrEqual(0);
    expect(source.events.slice(0, firstOpen).filter((event) => event === 'head')).toHaveLength(2);
  });

  it('requires the opaque list and head attestation to match before opening a stream', async () => {
    const row = trustedRow();
    const entry = fixtureEntry(row);
    const preflightDescriptor = {
      ...entry.descriptor,
      byteLength: entry.head?.byteLength,
      validator: Symbol('different-list-attestation'),
    } as unknown as MutableSkillDescriptor;
    const source = new ObservedLogicalSource([entry], {
      descriptors: [preflightDescriptor],
      truncated: false,
    });

    const result = await readerFor(source, [row]).load(CANARIES);

    expect(result).toEqual({ ok: false, failure: 'source_unavailable' });
    expect(source.openCalls).toEqual([]);
  });

  it('rejects conditional no-content, body-attestation races, short streams, and overrun streams', async () => {
    const row = trustedRow();
    const valid = encoder.encode(frontmatter(row));
    const validator = Symbol('fixture-version');
    const head = { byteLength: valid.byteLength, validator };
    const cases: readonly MutableSkillStream[] = [
      { validator: Symbol('different-body-attestation'), chunks: bytesStream(valid) },
      { validator, chunks: bytesStream(valid.slice(0, -1)) },
      { validator, chunks: bytesStream(valid, Uint8Array.of(46)) },
    ];

    for (const stream of cases) {
      const source = new ObservedLogicalSource([
        {
          descriptor: { name: row.name, byteLength: valid.byteLength, validator },
          head,
          stream,
        },
      ]);
      const result = await readerFor(source, [row]).load(CANARIES);

      expect(result).toEqual({ ok: false, failure: 'source_unavailable' });
    }

    const noContent = new ObservedLogicalSource([
      {
        descriptor: { name: row.name, byteLength: valid.byteLength, validator },
        head,
        stream: null,
      },
    ]);
    expect(await readerFor(noContent, [row]).load(CANARIES)).toEqual({
      ok: false,
      failure: 'source_unavailable',
    });
  });

  it('rejects fatal final-flush UTF-8, controls, and decoded text over the user-skill limit', async () => {
    const row = trustedRow();
    const validPrefix = encoder.encode(frontmatter(row));
    const controls = encoder.encode(frontmatter(row, 'A calm\u0000reminder.'));
    const decodedOverLimit = encoder.encode(frontmatter(row, 'x'.repeat(5_121)));
    const cases = [
      {
        byteLength: validPrefix.byteLength + 1,
        chunks: bytesStream(validPrefix, Uint8Array.of(0xc3)),
      },
      { byteLength: controls.byteLength, chunks: bytesStream(controls) },
      { byteLength: decodedOverLimit.byteLength, chunks: bytesStream(decodedOverLimit) },
    ] as const;

    for (const fixture of cases) {
      const validator = Symbol('fixture-version');
      const source = new ObservedLogicalSource([
        {
          descriptor: { name: row.name, byteLength: fixture.byteLength, validator },
          head: { byteLength: fixture.byteLength, validator },
          stream: { validator, chunks: fixture.chunks },
        },
      ]);

      expect(await readerFor(source, [row]).load(CANARIES)).toEqual({
        ok: false,
        failure: 'source_unavailable',
      });
    }
  });

  it('rejects malformed strict frontmatter rather than interpreting YAML-like syntax', async () => {
    const row = trustedRow();
    const lines = headerLines(row);
    const duplicated = [...lines];
    duplicated[12] = 'name: "calm-brief"';
    const unknown = [...lines];
    unknown[12] = 'unexpected: "value"';
    const missing = lines.slice(0, -1);
    const malformed = [
      `--\n${lines.join('\n')}\n---\nA calm reminder supports the planned brief.`,
      frontmatter(row).replace('---\n', '---\r\n'),
      rawFrontmatter(duplicated),
      rawFrontmatter(unknown),
      rawFrontmatter(missing),
      frontmatter(row, 'A calm reminder supports the planned brief.', { version: '1' }),
      frontmatter(row, 'A calm reminder supports the planned brief.', {
        required_tools: [['calendar.read']],
      }),
      rawFrontmatter(lines.map((line) => (line.startsWith('name: ') ? 'name: &link "calm-brief"' : line))),
      rawFrontmatter(lines.map((line) => (line.startsWith('name: ') ? 'name: !tag "calm-brief"' : line))),
      rawFrontmatter(lines.map((line) => (line.startsWith('name: ') ? '<<: {"name":"calm-brief"}' : line))),
      frontmatter(row, 'A calm reminder supports the planned brief.', {
        trigger_condition: 'x'.repeat(4_096),
      }),
    ];

    for (const text of malformed) {
      const source = new ObservedLogicalSource([fixtureEntry(row, text)]);
      expect(await readerFor(source, [row]).load(CANARIES)).toEqual({
        ok: false,
        failure: 'source_unavailable',
      });
    }
  });

  it('compares every R2 evidence field to the owner-bound trusted record and rebuilds authority from trust', async () => {
    const row = trustedRow();
    const alteredEvidence: Readonly<Record<string, unknown>> = {
      name: 'other-brief',
      version: 2,
      provenance: 'agent_authored',
      identity_locked: true,
      provisional: true,
      trigger_types: ['user_message'],
      trigger_condition: 'A different event is scheduled.',
      required_tools: ['calendar.read'],
      required_connectors: ['calendar'],
      effectiveness: 0.7,
      invocations: 1,
      last_used: '2026-07-11T00:00:00Z',
      created_at: '2026-07-11T00:00:00Z',
    };

    for (const [field, value] of Object.entries(alteredEvidence)) {
      const source = new ObservedLogicalSource([
        fixtureEntry(row, frontmatter(row, 'A calm reminder supports the planned brief.', { [field]: value })),
      ]);

      expect(await readerFor(source, [row]).load(CANARIES)).toEqual({
        ok: false,
        failure: 'source_unavailable',
      });
    }
  });

  it('omits stale and archived trusted records while retaining independently active mutable candidates', async () => {
    const active = trustedRow();
    const stale = trustedRow({ name: 'stale-brief', status: 'stale' });
    const archived = trustedRow({ name: 'archived-brief', status: 'archived' });
    const activeEntry = fixtureEntry(active);
    const staleEntry = fixtureEntry(stale);
    const archivedEntry = fixtureEntry(archived);
    const source = new ObservedLogicalSource([activeEntry, staleEntry, archivedEntry]);

    const result = await readerFor(source, [active, stale, archived]).load(CANARIES);

    expect(result).toEqual({
      ok: true,
      skills: [expect.objectContaining({ name: active.name })],
    });
    expect(source.events.filter((event) => event === 'head')).toHaveLength(3);
    expect(source.openCalls).toHaveLength(1);
  });

  it('drops the entire mutable source for missing, malformed, or non-mutable trusted records', async () => {
    const mutable = trustedRow();
    const system = skillRowSchema.parse({
      ...mutable,
      provenance: 'system',
      identity_locked: true,
      provisional: false,
    });
    const cases: readonly unknown[] = [null, {}, system];

    for (const record of cases) {
      const source = new ObservedLogicalSource([fixtureEntry(mutable)]);
      const reader = new MutableSkillReader({
        source,
        trustedRecords: { resolve: async () => record as SkillRow | null },
      });

      expect(await reader.load(CANARIES)).toEqual({ ok: false, failure: 'source_unavailable' });
      expect(source.openCalls).toEqual([]);
    }
  });

  it('admits an exact 5,120-unit body through the existing Scribe implementation and rejects 5,121 before it', async () => {
    const row = trustedRow();
    const exact = frontmatter(row, 'x'.repeat(5_120));
    const over = frontmatter(row, 'x'.repeat(5_121));
    const scribeSpy = vi.spyOn(scribe, 'prepareWithScribe');

    try {
      expect(
        await readerFor(new ObservedLogicalSource([fixtureEntry(row, exact)]), [row]).load(CANARIES),
      ).toEqual({
        ok: true,
        skills: [expect.objectContaining({ body_markdown: 'x'.repeat(5_120) })],
      });
      expect(scribeSpy).toHaveBeenCalledTimes(1);

      scribeSpy.mockClear();
      expect(
        await readerFor(new ObservedLogicalSource([fixtureEntry(row, over)]), [row]).load(CANARIES),
      ).toEqual({ ok: false, failure: 'source_unavailable' });
      expect(scribeSpy).not.toHaveBeenCalled();
    } finally {
      scribeSpy.mockRestore();
    }
  });

  it('enforces bounded frontmatter list cardinality and member units without imposing a blob cap', async () => {
    const triggers16 = Array.from({ length: 16 }, () => 'brief' as const);
    const triggers17 = Array.from({ length: 17 }, () => 'brief' as const);
    const tools32 = Array.from({ length: 32 }, (_, index) => `tool-${index}`);
    const tools33 = Array.from({ length: 33 }, (_, index) => `tool-${index}`);
    const connectors16 = Array.from({ length: 16 }, (_, index) => `connector-${index}`);
    const connectors17 = Array.from({ length: 17 }, (_, index) => `connector-${index}`);
    const fixtures = [
      { row: trustedRow({ trigger_types: triggers16 }), ok: true },
      { row: trustedRow({ trigger_types: triggers17 }), ok: false },
      { row: trustedRow({ required_tools: tools32 }), ok: true },
      { row: trustedRow({ required_tools: tools33 }), ok: false },
      { row: trustedRow({ required_connectors: connectors16 }), ok: true },
      { row: trustedRow({ required_connectors: connectors17 }), ok: false },
      { row: trustedRow({ required_tools: ['t'.repeat(100)] }), ok: true },
      { row: trustedRow({ required_tools: ['t'.repeat(101)] }), ok: false },
    ] as const;

    for (const fixture of fixtures) {
      const source = new ObservedLogicalSource([fixtureEntry(fixture.row)]);
      const result = await readerFor(source, [fixture.row]).load(CANARIES);
      expect(result.ok).toBe(fixture.ok);
    }
  });

  it('enforces the matching 1,024-unit trigger condition cap and exact 4KiB frontmatter boundary', async () => {
    const conditionAtLimit = trustedRow({ trigger_condition: 'c'.repeat(1_024) });
    const conditionOverLimit = trustedRow({ trigger_condition: 'c'.repeat(1_025) });
    expect(
      await readerFor(new ObservedLogicalSource([fixtureEntry(conditionAtLimit)]), [conditionAtLimit]).load(CANARIES),
    ).toEqual({ ok: true, skills: [expect.objectContaining({ name: conditionAtLimit.name })] });
    expect(
      await readerFor(new ObservedLogicalSource([fixtureEntry(conditionOverLimit)]), [conditionOverLimit]).load(CANARIES),
    ).toEqual({ ok: false, failure: 'source_unavailable' });

    const exact = frontmatterAtHeaderBytes(4 * 1024);
    const over = frontmatterAtHeaderBytes(4 * 1024 + 1);
    expect(frontmatterHeaderBytes(exact.text)).toBe(4 * 1024);
    expect(frontmatterHeaderBytes(over.text)).toBe(4 * 1024 + 1);
    const scribeSpy = vi.spyOn(scribe, 'prepareWithScribe');
    try {
      expect(
        await readerFor(new ObservedLogicalSource([fixtureEntry(exact.row, exact.text)]), [exact.row]).load(CANARIES),
      ).toEqual({ ok: true, skills: [expect.objectContaining({ name: exact.row.name })] });
      expect(scribeSpy).toHaveBeenCalledTimes(1);

      scribeSpy.mockClear();
      expect(
        await readerFor(new ObservedLogicalSource([fixtureEntry(over.row, over.text)]), [over.row]).load(CANARIES),
      ).toEqual({ ok: false, failure: 'source_unavailable' });
      expect(scribeSpy).not.toHaveBeenCalled();
    } finally {
      scribeSpy.mockRestore();
    }
  });

  it('preserves a byte-order mark for strict delimiter rejection while allowing LF and tab text', async () => {
    const row = trustedRow();
    const bom = `\uFEFF${frontmatter(row)}`;
    const tabs = frontmatter(row, 'A\tcalm reminder supports the planned brief.');
    const carriageReturn = frontmatter(row, 'A\rcalm reminder supports the planned brief.');

    expect(await readerFor(new ObservedLogicalSource([fixtureEntry(row, bom)]), [row]).load(CANARIES)).toEqual({
      ok: false,
      failure: 'source_unavailable',
    });
    expect(await readerFor(new ObservedLogicalSource([fixtureEntry(row, tabs)]), [row]).load(CANARIES)).toEqual({
      ok: true,
      skills: [expect.objectContaining({ body_markdown: expect.stringContaining('\t') })],
    });
    expect(await readerFor(new ObservedLogicalSource([fixtureEntry(row, carriageReturn)]), [row]).load(CANARIES)).toEqual({
      ok: false,
      failure: 'source_unavailable',
    });
  });

  it('stores only complete Scribe-admitted snapshots, re-runs Scribe on cache hits, and expires within one hour', async () => {
    const row = trustedRow();
    const source = new SingleLogicalSource(frontmatter(row));
    let now = 1_000;
    const reader = new MutableSkillReader({
      source,
      trustedRecords: { resolve: async () => row },
      now: () => now,
    });
    const scribeSpy = vi.spyOn(scribe, 'prepareWithScribe');

    try {
      const first = await reader.load(CANARIES);
      if (!first.ok || first.skills[0] === undefined) throw new Error('expected initial admission');
      first.skills[0].body_markdown = 'Caller mutation must not alter the cache.';

      const hit = await reader.load(CANARIES);
      expect(hit).toEqual({
        ok: true,
        skills: [expect.objectContaining({ body_markdown: 'A calm reminder supports the planned brief.' })],
      });
      expect(source.opened).toHaveLength(1);
      expect(scribeSpy).toHaveBeenCalledTimes(2);

      now += 60 * 60 * 1_000;
      expect(await reader.load(CANARIES)).toEqual({
        ok: true,
        skills: [expect.objectContaining({ name: row.name })],
      });
      expect(source.opened).toHaveLength(2);
      expect(scribeSpy).toHaveBeenCalledTimes(3);
    } finally {
      scribeSpy.mockRestore();
    }
  });

  it('evicts a cache entry when a re-admission denial occurs and refreshes rather than reusing it', async () => {
    const row = trustedRow();
    const source = new SingleLogicalSource(frontmatter(row));
    const reader = new MutableSkillReader({
      source,
      trustedRecords: { resolve: async () => row },
    });
    const original = scribe.prepareWithScribe;
    let denyCacheHit = false;
    const scribeSpy = vi.spyOn(scribe, 'prepareWithScribe').mockImplementation(
      ((...args: Parameters<typeof original>) => {
        const actual = original(...args);
        return denyCacheHit ? { ok: false, reason: 'untrusted_instruction' } : actual;
      }) as typeof original,
    );

    try {
      expect((await reader.load(CANARIES)).ok).toBe(true);
      denyCacheHit = true;
      expect(await reader.load(CANARIES)).toEqual({ ok: false, failure: 'source_unavailable' });
      denyCacheHit = false;
      expect((await reader.load(CANARIES)).ok).toBe(true);
      expect(source.opened).toHaveLength(2);
      expect(scribeSpy).toHaveBeenCalledTimes(3);
    } finally {
      scribeSpy.mockRestore();
    }
  });

  it('drops an in-flight generation after its bounded read and schedules no retry timer', async () => {
    const row = trustedRow();
    const base = new SingleLogicalSource(frontmatter(row));
    let reader: MutableSkillReader | undefined;
    let invalidateDuringOpen = true;
    const source: MutableSkillReadSource = {
      list: base.list.bind(base),
      head: base.head.bind(base),
      open: async (...args) => {
        const opened = await base.open(...args);
        if (invalidateDuringOpen) reader?.invalidate();
        return opened;
      },
    };
    reader = new MutableSkillReader({
      source,
      trustedRecords: { resolve: async () => row },
    });

    vi.useFakeTimers();
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      expect(await reader.load(CANARIES)).toEqual({ ok: false, failure: 'source_unavailable' });
      expect(base.opened).toHaveLength(1);
      expect(timerSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      invalidateDuringOpen = false;
      expect((await reader.load(CANARIES)).ok).toBe(true);
      expect(base.opened).toHaveLength(2);
    } finally {
      timerSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('never invokes writer-shaped fake operations while loading mutable skills', async () => {
    const row = trustedRow();
    const writer = {
      writeFile: vi.fn(),
      commit: vi.fn(),
      discard: vi.fn(),
    };
    const source = Object.assign(new SingleLogicalSource(frontmatter(row)), { writer });

    expect((await readerFor(source, [row]).load(CANARIES)).ok).toBe(true);
    expect(writer.writeFile).not.toHaveBeenCalled();
    expect(writer.commit).not.toHaveBeenCalled();
    expect(writer.discard).not.toHaveBeenCalled();
  });
});
