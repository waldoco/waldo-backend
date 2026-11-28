import type { AppSetupGoalV1 } from '../../../contracts/src/app/onboarding';
import type { QuestBook } from '../channels/quests';

// The quest the owner's setup goal is kept as. Remembered by id so a later answer changes that quest, not a new one.
const GOAL_QUEST_KEY = 'onboarding:goal_quest';

export type OnboardingGoal = Readonly<{
  // Sets the goal (the owner's words and day), or closes its quest for null.
  set(goal: AppSetupGoalV1 | null): void;
  // Whether the goal's quest is open now.
  held(): boolean;
  // The goal as the setup stage of the welcome build reads it, or null when none is open.
  line(): string | null;
}>;

// The goal the owner gave at setup is one of their quests (ADR-0064 GoalRecord as amended for quests), written through the quest
// book as set_quest writes one, so every turn, the Brief and the app read it from that one store. It starts active, with no plan
// and no check-in pace: those are agreed with the owner later, in chat. Synchronous, for the answers' transaction.
export const onboardingGoal = (kv: Pick<SyncKvStorage, 'get' | 'put'>, quests: Pick<QuestBook, 'set' | 'open'>, ownerRef: () => string): OnboardingGoal => {
  const open = () => { const id = kv.get<string>(GOAL_QUEST_KEY); return id === undefined ? undefined : quests.open().find(quest => quest.id === id); };
  return {
    set(goal) {
      const quest = open();
      if (goal === null) { if (quest) quests.set({ id: quest.id, state: 'completed' }, ownerRef()); return; }
      const result = quests.set(quest ? { id: quest.id, title: goal.own_words, deadline: goal.by } : { title: goal.own_words, deadline: goal.by, state: 'active' }, ownerRef());
      // Refused only when the owner already has as many open quests as a turn can carry: the answer is then not held.
      if (typeof result !== 'string') kv.put(GOAL_QUEST_KEY, result.quest.id);
    },
    held: () => open() !== undefined,
    line() {
      const quest = open();
      return quest ? `Working toward, in their own words: "${quest.title}"${quest.deadline ? `, by ${quest.deadline}` : ''}.` : null;
    },
  };
};
