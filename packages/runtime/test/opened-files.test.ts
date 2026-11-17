// The files a model opens from the owner's workspace ride on the rest of that one turn, within what one request takes.
import { LLM_ATTACHMENTS_MAX, type LLMAttachment } from '@waldo/contracts';
import { expect, it } from 'vitest';
import { OPENED_FILES_PER_TURN, openedFilesBook } from '../src/channels/opened-files';

const file = (name: string): LLMAttachment => ({ kind: 'file', mime_type: 'application/pdf', filename: name, data_base64: 'JVBERi0=' });

it('attaches what the model opened after the turn\'s own files, once each, and forgets it when the next turn starts', () => {
  const book = openedFilesBook();
  book.start(1);
  expect(book.open('a:1', file('a.pdf'))).toBe('attached');
  expect(book.open('a:1', file('a.pdf'))).toBe('attached');
  expect(book.with([file('own.pdf')]).map(f => f.filename)).toEqual(['own.pdf', 'a.pdf']);
  book.start(0);
  expect(book.with([])).toEqual([]);
});

it('promises a file only where one fits: at most two a turn, and never past what one request takes', () => {
  const book = openedFilesBook();
  book.start(0);
  for (let i = 0; i < OPENED_FILES_PER_TURN; i += 1) expect(book.open(`f:${i}`, file(`${i}.pdf`))).toBe('attached');
  expect(book.open('f:extra', file('extra.pdf'))).toBe('limit_reached');
  book.start(LLM_ATTACHMENTS_MAX - 1);
  expect(book.open('g:1', file('g.pdf'))).toBe('attached');
  expect(book.open('g:2', file('h.pdf'))).toBe('limit_reached');
  expect(book.with(Array.from({ length: LLM_ATTACHMENTS_MAX - 1 }, (_, i) => file(`own-${i}.pdf`)))).toHaveLength(LLM_ATTACHMENTS_MAX);
});
