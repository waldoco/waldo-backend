import { z } from 'zod';

// The parts of a life that the owner's memory and backlog are filed under, one vocabulary for both. Waldo sets an item's area
// and the owner can change it. unsorted is anything not yet filed, including everything written before areas existed.
// body and mind hold patterns in words, never a reading or a diagnosis.
export const LIFE_AREAS = ['body', 'mind', 'home', 'work', 'people', 'goals', 'money', 'unsorted'] as const;
export const lifeAreaSchema = z.enum(LIFE_AREAS);
export type LifeArea = z.infer<typeof lifeAreaSchema>;
