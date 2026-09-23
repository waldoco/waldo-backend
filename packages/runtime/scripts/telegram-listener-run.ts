import { readFile, writeFile } from 'node:fs/promises';
import { createTelegramCaller, createTelegramOwnerApi } from '../src/channels/telegram-api';
import { TelegramOwnerListener } from '../src/channels/telegram-listener';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';
import { createTelegramResponder } from '../src/channels/telegram-turn';

const ownerTelegramId = Number(process.env.WALDO_OWNER_TELEGRAM_ID ?? '0');
const offsetFile = process.env.WALDO_TELEGRAM_OFFSET_FILE ?? '/tmp/waldo-telegram-offset';
const telegram = createTelegramCaller(process.env.TELEGRAM_BOT_TOKEN ?? '');
const log = (event: object) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));

const listener = new TelegramOwnerListener({
  ownerTelegramId,
  api: createTelegramOwnerApi(telegram),
  ...createTelegramResponder(process.env.OPENAI_API_KEY ?? ''),
  log,
  saveOffset: (offset) => writeFile(offsetFile, String(offset)),
});

const stored = Number(await readFile(offsetFile, 'utf8').catch(() => process.env.WALDO_TELEGRAM_OFFSET ?? '0'));
const adapter = new TelegramPollingAdapter({
  getUpdates: async (request) => {
    const updates = await telegram('getUpdates', { ...request, allowed_updates: ['message'] }) as Array<{ update_id: number; message?: object }>;
    for (const update of updates) log({ event: 'update', update_id: update.update_id, fields: Object.keys(update.message ?? update) });
    return updates;
  },
}, stored);
log({ event: 'listener_started', offset: adapter.offset() });
for (;;) {
  try {
    const outcomes = await listener.pollOnce(adapter, 25);
    if (outcomes.length > 0) log({ event: 'turns', outcomes, offset: adapter.offset() });
  } catch (error) {
    log({ event: 'poll_error', error: (error as Error).message.replace(/bot\d+:[\w-]+/g, 'bot<redacted>') });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
