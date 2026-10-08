import { skillSchema, toolNameSchema, triggerTypeSchema, TOOL_PERMISSIONS, type Skill } from '@waldo/contracts';

export const BUNDLED_SKILL_MAX_BYTES = 8192;
export type BundledSkillFrontmatter = Readonly<{ name: string; description: string; tools: string[] }>;
export function parseSkillFrontmatter(source: string): { metadata: BundledSkillFrontmatter; body: string } {
  const lines = source.split('\n');
  if (lines[0] !== '---') throw new Error('skill_frontmatter_missing');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('skill_frontmatter_unclosed');
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error('skill_frontmatter_field_invalid');
    const key = line.slice(0, colon).trim();
    if (!['name','description','tools'].includes(key) || fields.has(key)) throw new Error('skill_frontmatter_field_invalid');
    fields.set(key, line.slice(colon + 1).trim());
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (!description || description.length > 200) throw new Error('skill_description_invalid');
  const tools: unknown = JSON.parse(fields.get('tools') ?? 'null');
  if (!Array.isArray(tools) || tools.some(tool => !toolNameSchema.safeParse(tool).success)) throw new Error('skill_tools_invalid');
  const body = lines.slice(end + 1).join('\n').trim();
  if (!body || new TextEncoder().encode(body).length > BUNDLED_SKILL_MAX_BYTES) throw new Error('skill_body_invalid');
  return { metadata: { name, description, tools }, body };
}
export function parseBundledSkill(source: string): Skill {
  const { metadata, body } = parseSkillFrontmatter(source);
  const skill = skillSchema.parse({ name: metadata.name, version: metadata.name==='document-email-preparation'?1:2, provenance: 'system', identity_locked: true, provisional: false,
    trigger_types: metadata.name==='document-email-preparation'?['user_message','brief']:triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('skills_load')),
    trigger_condition: metadata.description, required_tools: metadata.tools, required_connectors: [],
    effectiveness: 1, invocations: 0, last_used: null, body_markdown: body, created_at: metadata.name==='document-email-preparation'?'2026-10-01T00:00:00Z':'2026-10-03T00:00:00Z' });
  Object.freeze(skill.trigger_types); Object.freeze(skill.required_tools); Object.freeze(skill.required_connectors);
  return Object.freeze(skill);
}
