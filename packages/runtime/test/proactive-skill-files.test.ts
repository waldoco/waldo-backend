import { expect, it } from 'vitest';
import { TOOL_PERMISSIONS } from '@waldo/contracts';
import { CURATED_SKILLS } from '../src/skills/curated-owner';
import { TOOL_RECORDS } from '../src/tools/records';

// The proactive skills are reviewed procedures over tools that already exist: each tool they name is one an owner turn
// can reach and every turn can load the skill. Naming a tool grants it to nobody.
const PROACTIVE = ['intention-to-plan', 'relationship-upkeep', 'overload-day', 'renewals-and-bills', 'recovery-day'];

it.each(PROACTIVE)('%s names only existing owner-turn tools and loads on every trigger that can load a skill', (name) => {
  const skill = CURATED_SKILLS.find((entry) => entry.name === name);
  expect(skill, name).toBeDefined();
  for (const tool of skill!.required_tools) {
    expect(Object.keys(TOOL_RECORDS), tool).toContain(tool);
    expect(TOOL_PERMISSIONS.user_message, tool).toContain(tool);
  }
  expect(skill!.trigger_types).toContain('brief');
  expect(skill!.trigger_types).toContain('user_message');
});
