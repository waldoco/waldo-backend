import { z } from 'zod';
import { skillNameSchema } from '../../prompt/skill';
export const skillsListArgsSchema = z.strictObject({});
export const skillsVersionArgsSchema = z.strictObject({ name: skillNameSchema, version: z.int().positive() });
export type SkillsVersionArgs = z.infer<typeof skillsVersionArgsSchema>;
