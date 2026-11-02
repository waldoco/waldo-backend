import { expect, it, vi } from 'vitest';
import {
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  ANTHROPIC_CLAUDE_SONNET_5_5_MODEL,
  ANTHROPIC_PROVIDER,
  OPENAI_GPT_6_1_TERRA_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  OPENAI_PROVIDER,
} from '@waldo/contracts';
import { modelProviderSetting, ownerModels, ownerRoutePolicy } from '../src/llm/owner-routes';

// Which provider runs the owner path is one deploy setting, Claude unless it says openai. A provider whose key is not
// deployed cannot run it, so the other one does; with both keys, each route falls to the other provider.

const both = { openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic' };

it('reads the deploy setting as Claude unless it names openai exactly', () => {
  expect(modelProviderSetting('openai')).toBe(OPENAI_PROVIDER);
  expect(modelProviderSetting('anthropic')).toBe(ANTHROPIC_PROVIDER);
  for (const value of [undefined, '', 'OpenAI', 'gpt', 'claude']) expect(modelProviderSetting(value), String(value)).toBe(ANTHROPIC_PROVIDER);
});

it('runs owner turns on Sonnet and side jobs on Haiku when Claude is chosen and its key is deployed', () => {
  expect(ownerModels(both)).toEqual({ provider: ANTHROPIC_PROVIDER, chat: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, auxiliary: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL });
  expect(ownerModels({ ...both, primary: ANTHROPIC_PROVIDER }).provider).toBe(ANTHROPIC_PROVIDER);
});

it('runs owner turns on Terra and side jobs on Luna when the deploy chooses openai', () => {
  expect(ownerModels({ ...both, primary: OPENAI_PROVIDER })).toEqual({ provider: OPENAI_PROVIDER, chat: OPENAI_GPT_6_1_TERRA_MODEL, auxiliary: OPENAI_GPT_6_LUNA_MODEL });
});

it('runs on the provider whose key is deployed when the chosen one has none', () => {
  expect(ownerModels({ openaiApiKey: 'fixture-openai' }).provider).toBe(OPENAI_PROVIDER);
  expect(ownerModels({ openaiApiKey: 'fixture-openai', anthropicApiKey: '' }).provider).toBe(OPENAI_PROVIDER);
  expect(ownerModels({ openaiApiKey: '', anthropicApiKey: 'fixture-anthropic', primary: OPENAI_PROVIDER }).provider).toBe(ANTHROPIC_PROVIDER);
  // With neither key the chosen provider stays, and its own step reports the missing key.
  expect(ownerModels({ openaiApiKey: '' }).provider).toBe(ANTHROPIC_PROVIDER);
});

it('routes a Claude owner turn to Sonnet with the provider cache, then to Terra', () => {
  const [route] = ownerRoutePolicy(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, both).routes;
  expect(route!.primary).toEqual({ provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, cache: 'anthropic_native', max_tokens: 16_000 });
  expect(route!.fallback).toEqual([{ provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_1_TERRA_MODEL, cache: 'none', max_tokens: 4096 }]);
  expect(route!.floor).toBe('template');
});

it('routes a Claude side job to Haiku, then to Luna', () => {
  const [route] = ownerRoutePolicy(ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, both).routes;
  expect(route!.primary).toEqual({ provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, cache: 'none', max_tokens: 4096 });
  expect(route!.fallback).toEqual([{ provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_LUNA_MODEL, cache: 'none', max_tokens: 4096 }]);
});

it('keeps the OpenAI routes as they were: Terra then Sonnet, Luna then Haiku', () => {
  const [chat] = ownerRoutePolicy(OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_GPT_6_1_TERRA_MODEL, both).routes;
  expect(chat!.primary).toEqual({ provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_1_TERRA_MODEL, cache: 'none', max_tokens: 4096 });
  expect(chat!.fallback).toEqual([{ provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, cache: 'anthropic_native', max_tokens: 16_000 }]);
  const [side] = ownerRoutePolicy(OPENAI_GPT_6_LUNA_MODEL, OPENAI_GPT_6_1_TERRA_MODEL, both).routes;
  expect(side!.fallback).toEqual([{ provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, cache: 'none', max_tokens: 4096 }]);
});

it('has no fallback step when the other provider key is not deployed', () => {
  expect(ownerRoutePolicy(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, { openaiApiKey: '', anthropicApiKey: 'fixture-anthropic' }).routes[0]!.fallback).toEqual([]);
  expect(ownerRoutePolicy(OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_GPT_6_1_TERRA_MODEL, { openaiApiKey: 'fixture-openai' }).routes[0]!.fallback).toEqual([]);
});

it('logs each unrecognised value once, so a mistyped rollback is seen without a line per turn', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    for (const value of ['opneai', 'opneai', 'Open AI', 'opneai']) modelProviderSetting(value);
    modelProviderSetting(undefined);
    modelProviderSetting('');
    modelProviderSetting('openai');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({ hop: 'model_provider_unrecognised', ok: false, detail: 'WALDO_MODEL_PROVIDER is not anthropic or openai; the owner path runs on anthropic' });
  } finally {
    warn.mockRestore();
  }
});
