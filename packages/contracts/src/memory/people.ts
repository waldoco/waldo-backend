import { z } from 'zod';

// A person in the owner's memory: one identity that claims about them link to. Who someone is, which ring they belong in and
// which person a name means are the model's calls, and the owner's corrections stand over them; the code holds the shape.
export const PERSON_RINGS = ['inner', 'close', 'wider'] as const;
export const personRingSchema = z.enum(PERSON_RINGS);
export type PersonRing = z.infer<typeof personRingSchema>;
export const PERSON_ADDRESSES_MAX = 5;
export const PEOPLE_PER_CLAIM_MAX = 4;
export const PERSON_NAME_MAX = 120;
export const PERSON_RELATION_MAX = 60;

// subject: the claim is about them ("Priya is my sister"). object: they are the other side of it ("I owe Sam a reply").
// mention: they appear in it.
export const personRoleSchema = z.enum(['subject', 'object', 'mention']);
// ref names a person memory already holds (the id a read showed); name starts a new one. relation is the claim's phrase for
// the person ("sister", "manager at Acme"). This is the chat model's shape; the addresses a person is known by come from what
// Waldo sees in mail and the calendar, written by the claim store's own writers (PersonWrite).
export const personLinkSchema = z.strictObject({
  ref: z.int().positive().optional(),
  name: z.string().trim().min(1).max(PERSON_NAME_MAX).optional(),
  role: personRoleSchema,
  relation: z.string().trim().min(1).max(PERSON_RELATION_MAX).optional(),
}).refine((link) => (link.ref === undefined) !== (link.name === undefined), 'a person link names an existing ref or a new name, not both');
export type PersonLink = z.infer<typeof personLinkSchema>;
export const personAddressesSchema = z.array(z.email().max(320)).min(1).max(PERSON_ADDRESSES_MAX);
// How close someone is stays the owner's to set (the app's person.ring); the model's link names who, not how close.
export type PersonWrite = PersonLink & Readonly<{ ring?: PersonRing; addresses?: readonly string[] }>;

// A date that comes round each year (a birthday) is --MM-DD; one with a known year is YYYY-MM-DD. Both must be real days.
const realDay = (month: number, day: number, year = 2024): boolean => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
export const claimOnDateSchema = z.string().refine((value) => {
  const yearly = /^--(\d{2})-(\d{2})$/.exec(value);
  if (yearly) return realDay(Number(yearly[1]), Number(yearly[2]));
  const dated = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return dated !== null && realDay(Number(dated[2]), Number(dated[3]), Number(dated[1]));
}, 'a date as --MM-DD (every year) or YYYY-MM-DD');
