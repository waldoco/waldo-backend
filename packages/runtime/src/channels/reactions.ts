export const TELEGRAM_REACTIONS: readonly string[] = [
  '❤', '👍', '👎', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
];

const allowed = new Set(TELEGRAM_REACTIONS);

export const telegramReaction = (candidate: string | null): string | null => {
  const emoji = candidate?.replace(/\uFE0F/g, '').trim() ?? '';
  return allowed.has(emoji) ? emoji : null;
};

export const reactionInstruction = (choices: readonly string[]): string => [
  'You react to the user\'s chat message the way a close friend would. The 👀 you showed on arrival is replaced by this reaction once your reply is sent.',
  'Pick the reaction that fits the outcome and mood: 👌 for a plain done, 🙏 for thanks, 🎉 for good news, 🤣 for a joke, 😢 for sad news.',
  `Reply with exactly one emoji from this list and nothing else: ${choices.join(' ')}`,
].join('\n');
