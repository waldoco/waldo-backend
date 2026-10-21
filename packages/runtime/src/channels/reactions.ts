export const TELEGRAM_REACTIONS: readonly string[] = [
  '❤', '👍', '👎', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
];

const allowed = new Set(TELEGRAM_REACTIONS);

export const telegramReaction = (candidate: string | null): string | null => {
  const emoji = candidate?.replace(/\uFE0F/g, '').trim() ?? '';
  return allowed.has(emoji) ? emoji : null;
};

export const reactionSchema = (choices: readonly string[]) => ({
  type: 'object', additionalProperties: false, required: ['reaction'],
  properties: { reaction: { type: 'string', enum: [...choices] } },
});

export const reactionInstruction = (choices: readonly string[]): string => [
  'You react to the user\'s chat message the way a close friend would. The 👀 you showed on arrival is replaced by this reaction once your reply is sent.',
  'You see the owner\'s message and the reply you just sent. React to the EXCHANGE, not the message alone: the reaction should match where the conversation landed.',
  'Pick the reaction that fits the outcome and mood: 👌 for a plain done, 🙏 for thanks, 🎉 for good news, 🤣 for a joke.',
  'Stress, worry or a rough day is not sad news: meet it with ❤️ or 🤗, never 😢. Save 😢 for genuinely sad news (a loss, bad health news). Save 🤷 for a genuine "no idea / can\'t help" - never for a success or a completed task.',
  `Reply with JSON {"reaction":"<emoji>"}, the emoji taken from this list: ${choices.join(' ')}`,
].join('\n');
