// The owner's reviewed skill book in a trial, as the owner object hands one to every turn: the index is in every prompt
// and any turn, chat or card, may load a skill. The book follows the turn the trial is running, so a selection is that
// turn's alone. Every step gets the load-only book a machine turn gets; a production chat turn also offers skills_list and the
// owner's /skills lifecycle commands, which no scenario here exercises.
import type { OwnerSkillCapability } from '../../src/skills/curated-host';
import { createJobSkillCapability } from '../../src/skills/curated-host';
import { localTrustedBriefScheduleInput } from '../../src/llm/run-loop-adapters';

export const trialSkillBook = (sql: SqlStorage) => {
  const owner = localTrustedBriefScheduleInput().admission.verified_authority.principal_ref;
  const open = (turnId: string) => createJobSkillCapability(sql, { owner, turnId, trigger: 'user_message', ownerText: '', assertCurrent: async () => undefined });
  let current = open('trial-start');
  const capability: OwnerSkillCapability = Object.freeze({
    handlers: current.handlers.map(handler => ({ ...handler, handle: (args: never, ctx: never) => current.handlers.find(live => live.name === handler.name)!.handle(args, ctx) })),
    metadata: () => current.metadata(),
    prompt: (canaries: readonly string[]) => current.prompt(canaries),
    assertProcedureCurrent: (expected: string, canaries: readonly string[]) => current.assertProcedureCurrent(expected, canaries),
  });
  return { capability, turn: (turnId: string) => { current = open(turnId); } };
};
