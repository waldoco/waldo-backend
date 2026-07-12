import {
  skillNameSchema,
  skillRowSchema,
  skillSchema,
  type CanaryTokens,
  type Skill,
  type SkillName,
  type SkillRow,
} from '@waldo/contracts';
import * as scribe from '../scribe/prepare';

const USER_SKILL_DESCRIPTOR_LIMIT = 16;
const USER_SKILL_LIST_PROBE_LIMIT = USER_SKILL_DESCRIPTOR_LIMIT + 1;
const USER_SKILL_RAW_BYTES_LIMIT = 20 * 1024;
const USER_SKILL_BODY_RANGE_BYTES = USER_SKILL_RAW_BYTES_LIMIT + 1;
const USER_SKILL_REFRESH_BYTES_LIMIT = 320 * 1024;
const USER_SKILL_FRONTMATTER_BYTES_LIMIT = 4 * 1024;
const USER_SKILL_DECODED_UNITS_LIMIT = 5_120;
const USER_SKILL_TRIGGER_CONDITION_MAX_UNITS = 1_024;
const USER_SKILL_CACHE_TTL_MS = 60 * 60 * 1_000;
const USER_SKILL_TRIGGER_TYPES_MAX_ITEMS = 16;
const USER_SKILL_REQUIRED_TOOLS_MAX_ITEMS = 32;
const USER_SKILL_REQUIRED_CONNECTORS_MAX_ITEMS = 16;
const USER_SKILL_HEADER_LIST_MEMBER_MAX_UNITS = 100;
const USER_SKILL_FRONTMATTER_DELIMITER = '---\n';
const USER_SKILL_CLOSING_DELIMITER = '\n---\n';
const USER_SKILL_EVIDENCE_KEYS = [
  'name',
  'version',
  'provenance',
  'identity_locked',
  'provisional',
  'trigger_types',
  'trigger_condition',
  'required_tools',
  'required_connectors',
  'effectiveness',
  'invocations',
  'last_used',
  'created_at',
] as const;

type UserSkillEvidenceKey = (typeof USER_SKILL_EVIDENCE_KEYS)[number];
type UserSkillEvidence = Omit<Skill, 'body_markdown'>;

// The descriptor is logical and owner-bound by the injected source. Its validator never carries
// a serialisable storage version, and the reader never receives a storage location or authority.
export type MutableSkillDescriptor = Readonly<{
  name: SkillName;
  byteLength: number;
  validator: symbol;
}>;

export type MutableSkillHead = Readonly<{
  byteLength: number;
  validator: symbol;
}>;

export type MutableSkillStream = Readonly<{
  validator: symbol;
  chunks: AsyncIterable<Uint8Array>;
}>;

export type MutableSkillReadSource = Readonly<{
  list(limit: number): Promise<Readonly<{ descriptors: readonly MutableSkillDescriptor[]; truncated: boolean }>>;
  head(descriptor: MutableSkillDescriptor): Promise<MutableSkillHead | null>;
  open(
    descriptor: MutableSkillDescriptor,
    expected: MutableSkillHead,
    rangeBytes: number,
  ): Promise<MutableSkillStream | null>;
}>;

// The owning boundary is captured when this resolver is created. The reader can ask only for a
// canonical logical skill name, never an owner selector or mutable-storage address.
export type OwnerBoundSkillRecords = Readonly<{
  resolve(name: SkillName): Promise<SkillRow | null>;
}>;

export type MutableSkillReadResult =
  | Readonly<{ ok: true; skills: readonly Skill[] }>
  | Readonly<{ ok: false; failure: 'source_unavailable' }>;

type MutableSkillReaderDeps = Readonly<{
  source: MutableSkillReadSource;
  trustedRecords: OwnerBoundSkillRecords;
  now?: () => number;
}>;

type MutableSkillCandidate = Readonly<{
  descriptor: MutableSkillDescriptor;
  row: SkillRow;
  active: boolean;
}>;

type HeadedMutableSkillCandidate = MutableSkillCandidate &
  Readonly<{
    head: MutableSkillHead;
  }>;

type MutableSkillCache = Readonly<{
  skills: readonly Skill[];
  expiresAt: number;
  generation: number;
}>;

const SOURCE_FAILURE: MutableSkillReadResult = Object.freeze({
  ok: false as const,
  failure: 'source_unavailable' as const,
});
const TEXT_ENCODER = new TextEncoder();
const DISALLOWED_USER_SKILL_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const USER_SKILL_EVIDENCE_KEY_SET = new Set<string>(USER_SKILL_EVIDENCE_KEYS);

export class MutableSkillReader {
  #cache: MutableSkillCache | undefined;
  #generation = 0;

  constructor(private readonly deps: MutableSkillReaderDeps) {}

  invalidate(): void {
    this.#generation += 1;
    this.#cache = undefined;
  }

  async load(canaryTokens: CanaryTokens): Promise<MutableSkillReadResult> {
    try {
      const now = this.now();
      const cached = this.#cache;
      if (
        cached !== undefined &&
        cached.generation === this.#generation &&
        cached.expiresAt > now
      ) {
        return this.readCached(cached, canaryTokens);
      }
      if (cached !== undefined) this.#cache = undefined;
      return await this.refresh(canaryTokens, now);
    } catch {
      return SOURCE_FAILURE;
    }
  }

  private now(): number {
    const now = (this.deps.now ?? Date.now)();
    if (!Number.isSafeInteger(now)) throw new Error('invalid-clock');
    return now;
  }

  private async refresh(
    canaryTokens: CanaryTokens,
    refreshStartedAt: number,
  ): Promise<MutableSkillReadResult> {
    const generation = this.#generation;
    try {
      const listed = await this.deps.source.list(USER_SKILL_LIST_PROBE_LIMIT);
      if (!this.isCurrent(generation)) return SOURCE_FAILURE;
      const descriptors = validateDescriptors(listed);
      if (descriptors === null) return SOURCE_FAILURE;

      const candidates: MutableSkillCandidate[] = [];
      for (const descriptor of descriptors) {
        const row = await this.deps.trustedRecords.resolve(descriptor.name);
        if (!this.isCurrent(generation)) return SOURCE_FAILURE;
        const candidate = validateCandidate(descriptor, row);
        if (candidate === null) return SOURCE_FAILURE;
        candidates.push(candidate);
      }

      const headed: HeadedMutableSkillCandidate[] = [];
      for (const candidate of candidates) {
        const head = await this.deps.source.head(candidate.descriptor);
        if (!this.isCurrent(generation)) return SOURCE_FAILURE;
        if (!matchesDescriptorHead(candidate.descriptor, head)) return SOURCE_FAILURE;
        headed.push({
          ...candidate,
          head: Object.freeze({
            byteLength: candidate.descriptor.byteLength,
            validator: candidate.descriptor.validator,
          }),
        });
      }

      const admitted: Skill[] = [];
      for (const candidate of headed) {
        // Stale and archived trusted records are intentionally omitted rather than fabricated
        // as typed loader exclusions. They are still headed above so no body opens early.
        if (!candidate.active) continue;
        const opened = await this.deps.source.open(
          candidate.descriptor,
          candidate.head,
          USER_SKILL_BODY_RANGE_BYTES,
        );
        if (!this.isCurrent(generation)) return SOURCE_FAILURE;
        const text = await decodeBoundedStream(opened, candidate.head);
        if (!this.isCurrent(generation) || text === null) return SOURCE_FAILURE;

        const reconstructed = reconstructTrustedSkill(candidate.row, text);
        if (reconstructed === null) return SOURCE_FAILURE;
        const preparedBody = prepareMutableSkillBody(reconstructed.body_markdown, canaryTokens);
        if (preparedBody === null || !this.isCurrent(generation)) return SOURCE_FAILURE;
        const revalidated = revalidateSkillWithBody(reconstructed, preparedBody);
        if (revalidated === null) return SOURCE_FAILURE;
        admitted.push(copySkill(revalidated));
      }

      if (!this.isCurrent(generation)) return SOURCE_FAILURE;
      const expiresAt = refreshStartedAt + USER_SKILL_CACHE_TTL_MS;
      if (!Number.isSafeInteger(expiresAt)) return SOURCE_FAILURE;
      const cache: MutableSkillCache = Object.freeze({
        skills: Object.freeze(admitted.map(copySkill)),
        expiresAt,
        generation,
      });
      this.#cache = cache;
      return success(cache.skills);
    } catch {
      return SOURCE_FAILURE;
    }
  }

  private readCached(cache: MutableSkillCache, canaryTokens: CanaryTokens): MutableSkillReadResult {
    const admitted: Skill[] = [];
    for (const skill of cache.skills) {
      const preparedBody = prepareMutableSkillBody(skill.body_markdown, canaryTokens);
      const revalidated =
        preparedBody === null ? null : revalidateSkillWithBody(skill, preparedBody);
      if (revalidated === null || cache.generation !== this.#generation) {
        this.#cache = undefined;
        return SOURCE_FAILURE;
      }
      admitted.push(copySkill(revalidated));
    }

    const renewed: MutableSkillCache = Object.freeze({
      skills: Object.freeze(admitted.map(copySkill)),
      expiresAt: cache.expiresAt,
      generation: cache.generation,
    });
    this.#cache = renewed;
    return success(renewed.skills);
  }

  private isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }
}

function validateDescriptors(value: unknown): readonly MutableSkillDescriptor[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const listing = value as { descriptors?: unknown; truncated?: unknown };
  if (listing.truncated !== false || !Array.isArray(listing.descriptors)) return null;
  if (listing.descriptors.length > USER_SKILL_DESCRIPTOR_LIMIT) return null;

  const names = new Set<SkillName>();
  const descriptors: MutableSkillDescriptor[] = [];
  let aggregateBytes = 0;
  for (const value of listing.descriptors) {
    const descriptor = parseDescriptor(value);
    if (descriptor === null || names.has(descriptor.name)) return null;
    names.add(descriptor.name);
    aggregateBytes += descriptor.byteLength;
    if (aggregateBytes > USER_SKILL_REFRESH_BYTES_LIMIT) return null;
    descriptors.push(descriptor);
  }
  return descriptors;
}

function parseDescriptor(value: unknown): MutableSkillDescriptor | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { name?: unknown; byteLength?: unknown; validator?: unknown };
  const name = skillNameSchema.safeParse(candidate.name);
  if (
    !name.success ||
    !isBoundedByteLength(candidate.byteLength) ||
    candidate.byteLength > USER_SKILL_RAW_BYTES_LIMIT ||
    typeof candidate.validator !== 'symbol'
  ) {
    return null;
  }
  return Object.freeze({
    name: name.data,
    byteLength: candidate.byteLength,
    validator: candidate.validator,
  });
}

function validateCandidate(
  descriptor: MutableSkillDescriptor,
  value: unknown,
): MutableSkillCandidate | null {
  const row = skillRowSchema.safeParse(value);
  if (
    !row.success ||
    row.data.name !== descriptor.name ||
    (row.data.provenance !== 'user' && row.data.provenance !== 'agent_authored')
  ) {
    return null;
  }
  return Object.freeze({
    descriptor,
    row: row.data,
    active: row.data.status === 'active',
  });
}

function matchesDescriptorHead(
  descriptor: MutableSkillDescriptor,
  value: unknown,
): value is MutableSkillHead {
  if (typeof value !== 'object' || value === null) return false;
  const head = value as { byteLength?: unknown; validator?: unknown };
  return (
    isBoundedByteLength(head.byteLength) &&
    head.byteLength === descriptor.byteLength &&
    head.byteLength <= USER_SKILL_RAW_BYTES_LIMIT &&
    head.validator === descriptor.validator
  );
}

function isBoundedByteLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

async function decodeBoundedStream(
  value: unknown,
  expected: MutableSkillHead,
): Promise<string | null> {
  if (typeof value !== 'object' || value === null) return null;
  const stream = value as { validator?: unknown; chunks?: unknown };
  if (stream.validator !== expected.validator || !isAsyncByteStream(stream.chunks)) return null;

  try {
    // Keep a BOM visible so the strict opening delimiter rejects it rather than silently
    // normalising the first storage bytes into trusted-looking frontmatter.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let byteLength = 0;
    let text = '';
    for await (const chunk of stream.chunks) {
      if (!(chunk instanceof Uint8Array)) return null;
      byteLength += chunk.byteLength;
      if (byteLength > expected.byteLength || byteLength > USER_SKILL_RAW_BYTES_LIMIT) return null;
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    if (
      byteLength !== expected.byteLength ||
      DISALLOWED_USER_SKILL_CONTROL.test(text)
    ) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

function isAsyncByteStream(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

function reconstructTrustedSkill(row: SkillRow, text: string): Skill | null {
  if (!text.startsWith(USER_SKILL_FRONTMATTER_DELIMITER)) return null;
  const closing = text.indexOf(USER_SKILL_CLOSING_DELIMITER, USER_SKILL_FRONTMATTER_DELIMITER.length);
  if (closing < 0) return null;
  const headerEnd = closing + USER_SKILL_CLOSING_DELIMITER.length;
  if (TEXT_ENCODER.encode(text.slice(0, headerEnd)).byteLength > USER_SKILL_FRONTMATTER_BYTES_LIMIT) {
    return null;
  }

  const lines = text
    .slice(USER_SKILL_FRONTMATTER_DELIMITER.length, closing)
    .split('\n');
  if (lines.length !== USER_SKILL_EVIDENCE_KEYS.length) return null;

  const values: Partial<Record<UserSkillEvidenceKey, unknown>> = {};
  for (const line of lines) {
    const matched = /^([a-z_]+): (.+)$/.exec(line);
    if (matched === null) return null;
    const key = matched[1];
    const literal = matched[2];
    if (
      key === undefined ||
      literal === undefined ||
      !USER_SKILL_EVIDENCE_KEY_SET.has(key) ||
      Object.hasOwn(values, key) ||
      literal.trim() !== literal
    ) {
      return null;
    }
    try {
      const value = JSON.parse(literal);
      if (hasNestedObject(value) || !hasAllowedListShape(key, value)) return null;
      values[key as UserSkillEvidenceKey] = value;
    } catch {
      return null;
    }
  }

  if (Object.keys(values).length !== USER_SKILL_EVIDENCE_KEYS.length) return null;
  const body_markdown = text.slice(headerEnd);
  if (body_markdown.length > USER_SKILL_DECODED_UNITS_LIMIT) return null;
  const parsed = skillSchema.safeParse({
    ...values,
    body_markdown,
  });
  if (
    !parsed.success ||
    parsed.data.trigger_condition.length > USER_SKILL_TRIGGER_CONDITION_MAX_UNITS ||
    !evidenceMatchesTrustedRow(parsed.data, row)
  ) {
    return null;
  }

  return trustedSkillWithBody(row, parsed.data.body_markdown);
}

function hasNestedObject(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => typeof item === 'object' && item !== null);
  return typeof value === 'object' && value !== null;
}

function hasAllowedListShape(key: string, value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  const maxItems =
    key === 'required_tools'
      ? USER_SKILL_REQUIRED_TOOLS_MAX_ITEMS
      : key === 'trigger_types'
        ? USER_SKILL_TRIGGER_TYPES_MAX_ITEMS
        : key === 'required_connectors'
          ? USER_SKILL_REQUIRED_CONNECTORS_MAX_ITEMS
        : 0;
  return (
    value.length <= maxItems &&
    value.every((item) => typeof item === 'string' && item.length <= USER_SKILL_HEADER_LIST_MEMBER_MAX_UNITS)
  );
}

function evidenceMatchesTrustedRow(candidate: Skill, row: SkillRow): boolean {
  const trusted = trustedSkillWithBody(row, candidate.body_markdown);
  for (const key of USER_SKILL_EVIDENCE_KEYS) {
    const candidateValue = candidate[key];
    const trustedValue = trusted[key];
    if (Array.isArray(candidateValue) || Array.isArray(trustedValue)) {
      if (!Array.isArray(candidateValue) || !Array.isArray(trustedValue)) return false;
      if (
        candidateValue.length !== trustedValue.length ||
        candidateValue.some((value, index) => value !== trustedValue[index])
      ) {
        return false;
      }
      continue;
    }
    if (candidateValue !== trustedValue) return false;
  }
  return true;
}

function trustedSkillWithBody(row: SkillRow, body_markdown: string): Skill {
  return {
    name: row.name,
    version: row.version,
    provenance: row.provenance,
    identity_locked: row.identity_locked,
    provisional: row.provisional,
    trigger_types: [...row.trigger_types],
    trigger_condition: row.trigger_condition,
    required_tools: [...row.required_tools],
    required_connectors: [...row.required_connectors],
    effectiveness: row.effectiveness,
    invocations: row.invocations,
    last_used: row.last_used,
    body_markdown,
    created_at: row.created_at,
  };
}

function prepareMutableSkillBody(body: string, canaryTokens: CanaryTokens): string | null {
  const prepared = scribe.prepareWithScribe(
    body,
    skillSchema.shape.body_markdown,
    'skill_body',
    'external',
    canaryTokens,
  );
  return prepared.ok ? prepared.value : null;
}

function revalidateSkillWithBody(skill: Skill, body_markdown: string): Skill | null {
  const parsed = skillSchema.safeParse({
    ...copySkill(skill),
    body_markdown,
  });
  return parsed.success ? parsed.data : null;
}

function copySkill(skill: Skill): Skill {
  return {
    ...skill,
    trigger_types: [...skill.trigger_types],
    required_tools: [...skill.required_tools],
    required_connectors: [...skill.required_connectors],
  };
}

function success(skills: readonly Skill[]): MutableSkillReadResult {
  return Object.freeze({
    ok: true as const,
    skills: Object.freeze(skills.map(copySkill)),
  });
}
