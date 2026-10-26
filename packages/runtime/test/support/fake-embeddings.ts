import type { EmbeddingRunner } from '../../src/memory/semantic-recall';

// A stand-in for the Workers AI embedding binding. Each concept is one dimension, and a text points along every concept whose
// words it uses, so a paraphrase that shares no word with a claim can still share a concept. It proves the plumbing (writes,
// fusion, filters, forget), not the quality of a real model. `inputs` records every text the binding was sent.
const CONCEPTS: readonly (readonly string[])[] = [
  ['dentist', 'dental', 'teeth', 'tooth', 'molar'],
  ['gym', 'workout', 'exercise', 'locker', 'training'],
  ['heart', 'pulse', 'bpm', 'cardio'],
  ['coffee', 'espresso', 'latte', 'cafe'],
  ['sister', 'sibling', 'brother'],
];
export const conceptVector = (text: string): number[] => {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return CONCEPTS.map((concept) => words.filter((word) => concept.includes(word)).length);
};

export type FakeEmbeddings = EmbeddingRunner & { inputs: string[]; calls: number; fail: boolean; hold?: Promise<void> };
export const fakeEmbeddings = (): FakeEmbeddings => {
  const fake: FakeEmbeddings = {
    inputs: [], calls: 0, fail: false,
    async run(_model, { text }) {
      fake.calls += 1;
      fake.inputs.push(...text);
      if (fake.hold) await fake.hold;
      if (fake.fail) throw new Error('workers ai unavailable');
      const data = text.map(conceptVector);
      return { shape: [data.length, CONCEPTS.length], data, pooling: 'cls' };
    },
  };
  return fake;
};
