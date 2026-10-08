import { expect, it } from 'vitest';
import { CURATED_SKILLS } from '../src/skills/curated-owner';
import { messagingSystemPrompt, withOwnerSkillProcedures } from '../src/prompt/messaging-behavior';

const names = ['day-brief','meeting-prep','inbox-triage-reply-draft','sourced-research-brief','calendar-focus-proposal','artifact-revision-delivery','weekly-review','follow-up-prep','reminders-and-watches','reviewed-outbound-message','project-catch-up','meal-activity-log-and-planning','memory-correction','travel-prep','decision-brief'];
it.each(names)('the owner can discover a ready-to-use %s procedure with named tools', name => {
  const skill = CURATED_SKILLS.find(s => s.name === name);
  expect(skill, name).toBeDefined();
  expect(skill!.trigger_condition.length).toBeLessThanOrEqual(200);
  expect(skill!.required_tools.length).toBeGreaterThan(0);
  expect(skill!.body_markdown).toContain('Done');
});
it('loading a procedure does not duplicate the doing and health instructions', () => {
  const base = messagingSystemPrompt([]);
  const prompt = withOwnerSkillProcedures(base, 'Selected procedure');
  const boundary = 'Anything that reaches another person, spends money or changes a shared calendar needs';
  expect(prompt.split(boundary).length).toBe(base.split(boundary).length);
});

import { BUNDLED_SKILL_FILES } from '../src/skills/bundled-text';
import { parseBundledSkill, parseSkillFrontmatter } from '../src/skills/bundled-file';
for(const source of BUNDLED_SKILL_FILES) {
  it(`frontmatter schema: ${parseSkillFrontmatter(source).metadata.name}`, () => {
    const parsed=parseBundledSkill(source);
    expect(parsed.trigger_condition.length).toBeLessThanOrEqual(200);
    expect(parsed.name).toBe(parseSkillFrontmatter(source).metadata.name);
  });
}
it.each([
  'name: missing-delimiters',
  '---\nname: test\ndescription: valid\ntools: ["made_up_tool"]\n---\nBody',
  '---\nname: test\ndescription: '+ 'x'.repeat(201) +'\ntools: []\n---\nBody',
  '---\nname: test\nname: duplicate\ndescription: valid\ntools: []\n---\nBody',
  '---\nname: test\ndescription: valid\ntools: []\n---\n</skill>',
])('rejects malformed bundled frontmatter/body %s', source=>expect(()=>parseBundledSkill(source)).toThrow());

it('every file-backed procedure uses a unique catalog name', () => {
  expect(new Set(CURATED_SKILLS.map(s=>s.name)).size).toBe(CURATED_SKILLS.length);
});
