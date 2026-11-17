import { LLM_ATTACHMENTS_MAX, type LLMAttachment } from '@waldo/contracts';

// Files the model opened from the owner's workspace during one turn (a PDF or photo the owner sent in an earlier message),
// attached to that turn's later model steps so the model reads the file itself. The book belongs to one owner's responder and
// is emptied as each turn starts: nothing is stored, and a turn never sees another turn's files.
export const OPENED_FILES_PER_TURN = 2;
export type OpenedFile = 'attached' | 'limit_reached' | 'unavailable';
export type OpenFile = (key: string, file: LLMAttachment) => OpenedFile;

export const openedFilesBook = () => {
  let opened = new Map<string, LLMAttachment>();
  // How many files the turn's own message already hands the model, so an opened file is promised only where one fits.
  let carried = 0;
  return {
    // A new turn, carrying `count` files of its own.
    start(count: number): void { opened = new Map(); carried = count; },
    open: ((key, file) => {
      if (!opened.has(key) && (opened.size >= OPENED_FILES_PER_TURN || carried + opened.size >= LLM_ATTACHMENTS_MAX)) return 'limit_reached';
      opened.set(key, file);
      return 'attached';
    }) satisfies OpenFile,
    // The files a model step carries: the turn's own first, then what the model opened, up to what one request takes.
    with(files: readonly LLMAttachment[]): LLMAttachment[] { return [...files, ...opened.values()].slice(0, LLM_ATTACHMENTS_MAX); },
  };
};
