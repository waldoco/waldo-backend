import { expect, it } from 'vitest';
import { consolidationDay, type Episode } from '../src/channels/episodes';

const at = Date.parse('2026-09-30T10:00:00Z');
const day: readonly Episode[] = [
  { entry_id: 'tg-1', speaker: 'owner', at, text: 'I switched to mornings for gym' },
  { entry_id: 'tg-1-reply', speaker: 'waldo', at, text: 'Noted.' },
  { entry_id: 'reminder:ab:1:0', speaker: 'system', at, text: '[Reminder due now, set earlier by the owner: "verify the task list"] Send the reminder briefly.' },
];

it('nightly consolidation reads only owner and Waldo turns, never machine-written entries', () => {
  expect(consolidationDay(day).map((episode) => episode.entry_id)).toEqual(['tg-1', 'tg-1-reply']);
});
