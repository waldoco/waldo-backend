import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toolParameters, toolNameSchema, PRIVILEGED_ACTION_TOOLS, EXTERNAL_ORIGIN_TOOLS, type ToolName } from '@waldo/contracts';
import { MESSAGING_BEHAVIOR } from '../../src/prompt/messaging-behavior';
import { reactionInstruction, reactionSchema, TELEGRAM_REACTIONS } from '../../src/channels/reactions';
import { MEMORY_INSTRUCTION, NIGHTLY_MEMORY_INSTRUCTION, CLAIM_OPS_SCHEMA } from '../../src/memory/claims';
import { DAY_PLAN_INSTRUCTION, DAY_PLAN_SCHEMA } from '../../src/prompt/day-cards';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
export const digest = (value: unknown): string => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const promptBody = z.object({
  id: z.enum(['waldo.reply', 'waldo.reaction', 'waldo.memory-extraction', 'waldo.nightly-consolidation', 'waldo.day-planning']),
  instruction: z.string().min(1), response_schema: z.record(z.string(), z.unknown()).nullable(),
  source: z.string().min(1), local_inputs: z.array(z.string().min(1)),
}).strict();
const promptEntry = promptBody.extend({ version: z.number().int().positive(), source_revision: revision, content_digest: hash }).strict();
const promptCatalog = z.object({ format: z.literal(1), entries: z.array(promptEntry).min(5), digest: hash }).strict();
export type PromptEntry = z.infer<typeof promptEntry>;
export type PromptCatalog = z.infer<typeof promptCatalog>;
const content = ({ version: _version, source_revision: _revision, content_digest: _digest, ...body }: PromptEntry) => body;
const seal = (entries: PromptEntry[]): PromptCatalog => ({ format: 1, entries, digest: digest({ format: 1, entries }) });

export const buildPromptCatalog = (sourceRevision: string): PromptCatalog => {
  revision.parse(sourceRevision);
  const bodies: z.infer<typeof promptBody>[] = [
    { id: 'waldo.reply', instruction: MESSAGING_BEHAVIOR, response_schema: null, source: 'src/prompt/messaging-behavior.ts#MESSAGING_BEHAVIOR', local_inputs: ['available tools', 'owner clock', 'owner memories', 'standing orders', 'conversation history'] },
    { id: 'waldo.reaction', instruction: reactionInstruction(TELEGRAM_REACTIONS), response_schema: reactionSchema(TELEGRAM_REACTIONS), source: 'src/channels/reactions.ts#reactionInstruction', local_inputs: ['owner message', 'last reply'] },
    { id: 'waldo.memory-extraction', instruction: MEMORY_INSTRUCTION, response_schema: CLAIM_OPS_SCHEMA, source: 'src/memory/claims.ts#MEMORY_INSTRUCTION', local_inputs: ['memory', 'barrier', 'owner/shared provenance', 'reply'] },
    { id: 'waldo.nightly-consolidation', instruction: NIGHTLY_MEMORY_INSTRUCTION, response_schema: CLAIM_OPS_SCHEMA, source: 'src/memory/claims.ts#NIGHTLY_MEMORY_INSTRUCTION', local_inputs: ['memory', 'barrier', 'daily conversation', 'consolidation grounding'] },
    { id: 'waldo.day-planning', instruction: DAY_PLAN_INSTRUCTION, response_schema: DAY_PLAN_SCHEMA, source: 'src/prompt/day-cards.ts#DAY_PLAN_INSTRUCTION', local_inputs: ['owner memories', 'local clock', 'calendar', 'cards', 'proactivity'] },
  ];
  return seal(bodies.map((body) => ({ ...body, version: 1, source_revision: sourceRevision, content_digest: digest(body) })));
};

export const loadPromptCatalog = (bytes: string): PromptCatalog => {
  const catalog = promptCatalog.parse(JSON.parse(bytes));
  if (catalog.digest !== digest({ format: catalog.format, entries: catalog.entries })) throw new Error('catalog digest mismatch');
  const keys = new Set<string>();
  for (const entry of catalog.entries) {
    const key = `${entry.id}@${entry.version}`;
    if (keys.has(key) || entry.content_digest !== digest(content(entry))) throw new Error('duplicate version or prompt digest mismatch');
    keys.add(key);
  }
  if (new Set(catalog.entries.map((entry) => entry.id)).size !== 5) throw new Error('missing prompt template');
  return catalog;
};
export const selectPrompt = (catalog: PromptCatalog, id: PromptEntry['id'], version: number): PromptEntry => {
  const verified = loadPromptCatalog(JSON.stringify(catalog));
  const entry = verified.entries.find((item) => item.id === id && item.version === version);
  if (!entry) throw new Error(`unknown prompt version: ${id}@${version}`);
  return entry;
};
// Explicit snapshots retain prior versions. No mutable "latest" pointer is consulted.
export const appendPromptVersion = (catalog: PromptCatalog, entry: PromptEntry): PromptCatalog => {
  const verified = loadPromptCatalog(JSON.stringify(catalog));
  const latest = Math.max(...verified.entries.filter((item) => item.id === entry.id).map((item) => item.version));
  if (entry.version !== latest + 1) throw new Error('version must increment by one');
  return loadPromptCatalog(JSON.stringify(seal([...verified.entries, entry])));
};

export type ReflectedHandler = Readonly<{ name: ToolName; description: string; schema: Parameters<typeof toolParameters>[0]; trigger_allowlist: readonly string[]; autonomy_gated: boolean; mutates_state?: true; idempotentOnKey?: true }>;
export const buildToolCatalog = (handlers: readonly ReflectedHandler[], version: number, sourceRevision: string) => {
  revision.parse(sourceRevision);
  z.number().int().positive().parse(version);
  if (new Set(handlers.map((handler) => handler.name)).size !== handlers.length) throw new Error('duplicate tool name');
  const entries = handlers.map((handler) => ({
    name: handler.name, description: handler.description, parameters: toolParameters(handler.schema),
    trigger_allowlist: [...handler.trigger_allowlist], autonomy_gated: handler.autonomy_gated,
    mutates_state: handler.mutates_state ?? null, idempotent_on_key: handler.idempotentOnKey ?? null,
    side_effect_class: PRIVILEGED_ACTION_TOOLS.includes(handler.name) ? 'privileged_action' : handler.mutates_state ? 'state_mutation' : 'unspecified',
    approval_requirement: PRIVILEGED_ACTION_TOOLS.includes(handler.name) ? 'runtime_privileged_gate' : 'handler_specific_unverified',
    external_origin: EXTERNAL_ORIGIN_TOOLS.includes(handler.name),
  }));
  const body = { format: 1 as const, version, source_revision: sourceRevision, entries };
  return { ...body, digest: digest(body) };
};
export type ToolCatalog = ReturnType<typeof buildToolCatalog>;
const toolCatalogSchema = z.object({
  format: z.literal(1), version: z.number().int().positive(), source_revision: revision,
  entries: z.array(z.object({
    name: z.string().refine((name) => toolNameSchema.safeParse(name).success), description: z.string(), parameters: z.record(z.string(), z.unknown()),
    trigger_allowlist: z.array(z.string()), autonomy_gated: z.boolean(), mutates_state: z.literal(true).nullable(), idempotent_on_key: z.literal(true).nullable(),
    side_effect_class: z.enum(['privileged_action', 'state_mutation', 'unspecified']),
    approval_requirement: z.enum(['runtime_privileged_gate', 'handler_specific_unverified']), external_origin: z.boolean(),
  }).strict()), digest: hash,
}).strict();
export const loadToolCatalog = (bytes: string) => {
  const catalog = toolCatalogSchema.parse(JSON.parse(bytes));
  const { digest: expected, ...body } = catalog;
  if (expected !== digest(body) || new Set(catalog.entries.map((entry) => entry.name)).size !== catalog.entries.length) throw new Error('tool catalog digest or identity invalid');
  return catalog;
};
