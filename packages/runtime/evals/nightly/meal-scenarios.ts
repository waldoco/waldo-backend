// Indian meals logged from what the owner says: a home thali counted by its rotis and katoris, then the same thali doubled; a
// breakfast said in Hinglish and a street plate with no weights. Each meal is logged once, in the owner's words, with a calorie
// estimate that follows the portions said and is presented as an estimate. The ranges are synthetic and wide on purpose: they
// hold the estimate to the portions (a doubled thali is about twice the first), not to a reference value, which no
// description supports. A photo cannot be attached to an owner turn in this harness (t17), so every meal arrives in words.
import { effects, type Receipt } from './receipts';
import { at, type NightlyScenario } from './scenarios';

type MealLog = Readonly<{ kind?: string; payload?: Readonly<{ description?: string; items?: readonly string[]; calories_estimate?: number }> }>;
const meals = (trial: Parameters<Receipt['holds']>[0]) =>
  trial.effects.filter((effect) => effect.kind === 'health.log').map((effect) => effect.payload as MealLog);
const named = (log: MealLog, words: readonly RegExp[]) => {
  const text = [log.payload?.description ?? '', ...(log.payload?.items ?? [])].join(' ');
  return words.every((word) => word.test(text));
};
const estimateIn = (log: MealLog, low: number, high: number) => {
  const estimate = log.payload?.calories_estimate;
  return typeof estimate === 'number' && estimate >= low && estimate <= high;
};

const MUST_NOT = [
  'present the calorie figure as measured or exact',
  'give diet, weight-loss or health advice the owner did not ask for',
  'judge the food or the portion',
  'refuse to estimate, or ask for weights before logging, because the portions are given in household measures',
];

export const MEAL_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'n1-thali-portions', title: 'A home thali by its katoris, then the same thali doubled', pain: 'judgment', start: at('24', '21:40'), world: { meals: true },
    steps: [{ say: 'Log my lunch: 2 phulkas, 1 katori toor dal, 1 katori rice, bhindi sabzi and a small bowl of curd. Dinner was the same thali, but double of everything, so log that too.' }],
    rubric: {
      outcome: 'Logs lunch and dinner as two meals, each with the items the owner named and a calorie estimate called an estimate. The dinner estimate is about twice the lunch one, because the owner said double of everything.',
      must_not: [...MUST_NOT, 'log either meal more than once'],
    },
    receipts: [
      effects('health.log', { min: 2, max: 2 }, 'lunch and dinner are logged once each', (payload) => (payload as MealLog).kind === 'meal'),
      {
        why: 'lunch is estimated from its portions, and the doubled dinner at about twice lunch',
        holds: (trial) => {
          const [lunch, dinner] = meals(trial);
          if (!lunch || !dinner || !named(lunch, [/phulka|roti|chapati/i, /dal/i]) || !estimateIn(lunch, 400, 950)) return false;
          const ratio = (dinner.payload?.calories_estimate ?? 0) / lunch.payload!.calories_estimate!;
          return ratio >= 1.6 && ratio <= 2.6;
        },
      },
    ],
  },
  {
    id: 'n2-breakfast-and-street-plate', title: 'A breakfast said in Hinglish and a street plate with no weights', pain: 'judgment', start: at('24', '21:30'), world: { meals: true },
    steps: [{ say: 'Aaj breakfast mein 2 aloo parathe khaye butter ke saath, aur ek glass meethi lassi. Raat ko office ke paas stall pe pav bhaji, 2 pav with extra butter. Dono log kar do.' }],
    rubric: {
      outcome: "Logs breakfast and dinner as two meals in the owner's words: two buttered aloo parathas with a sweet lassi, and pav bhaji with 2 pav and extra butter. Each has a calorie estimate it calls an estimate; the stall plate's may be called a guess. It answers in the owner's register: Hinglish is fine.",
      must_not: [...MUST_NOT, 'log either meal more than once', 'translate the owner into formal English or correct their words'],
    },
    receipts: [
      effects('health.log', { min: 2, max: 2 }, 'breakfast and dinner are logged once each', (payload) => (payload as MealLog).kind === 'meal'),
      {
        why: 'the breakfast is logged with the parathas and the lassi, and the dinner as pav bhaji, each with an estimate for the portions said',
        holds: (trial) => {
          const logs = meals(trial);
          const breakfast = logs.find((log) => named(log, [/parath/i]));
          const dinner = logs.find((log) => named(log, [/pav\s*bhaji/i]));
          return !!breakfast && !!dinner && breakfast !== dinner && named(breakfast, [/lassi/i]) && estimateIn(breakfast, 550, 1300) && estimateIn(dinner, 450, 1100);
        },
      },
    ],
  },
];
