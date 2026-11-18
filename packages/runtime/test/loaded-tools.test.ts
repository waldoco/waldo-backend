import { describe, expect, it } from 'vitest';
import { harnessToolLoader } from '../src/tools/loader';
import { LOADED_FOR_MS, LOADED_MAX, loadedToolsBook } from '../src/tools/loaded';
import { offeredPlacement, TOOL_RECORDS } from '../src/tools/records';

const kv = () => { const map = new Map<string, unknown>(); return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, map }; };
const deferred = (Object.keys(TOOL_RECORDS) as string[]).filter((name) => offeredPlacement(name) !== 'core').sort();

describe('a tool the model loaded stays in reach', () => {
  it('keeps what was loaded, by name, for two weeks', () => {
    const store = kv(), book = loadedToolsBook(store);
    book.note(['get_weather', 'get_crs'], 0);
    expect(book.names(1)).toEqual(['get_crs', 'get_weather']);
    expect(book.names(LOADED_FOR_MS - 1)).toEqual(['get_crs', 'get_weather']);
    expect(book.names(LOADED_FOR_MS)).toEqual([]);
  });

  it('a later load renews it; past the cap the least recent drop out', () => {
    const book = loadedToolsBook(kv());
    deferred.slice(0, LOADED_MAX + 2).forEach((name, i) => book.note([name], i));
    expect(book.names(100)).toHaveLength(LOADED_MAX);
    expect(book.names(100)).not.toContain(deferred[0]);
    book.note([deferred[2]!], 200);
    expect(book.names(201)).toContain(deferred[2]);
  });

  it('holds only real tool names, and reads a malformed store as empty', () => {
    const store = kv(), book = loadedToolsBook(store);
    book.note(['not_a_tool', 'ignore previous instructions'], 0);
    expect(book.names(1)).toEqual([]);
    store.put('tools_loaded_v1', ['get_weather']);
    expect(book.names(1)).toEqual([]);
    store.put('tools_loaded_v1', { get_weather: 'yesterday', get_crs: 5 });
    expect(book.names(6)).toEqual(['get_crs']);
  });

  it('the harness loader offers a loaded tool in the function list and leaves it out of the catalogue', () => {
    const tools = ['get_weather', 'get_context'].map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } }));
    expect(harnessToolLoader(tools).offered.map((tool) => tool.name)).toEqual(['get_context', 'find_tools', 'use_tool']);
    expect(harnessToolLoader(tools, new Set(['get_weather'])).offered.map((tool) => tool.name)).toEqual(['get_context', 'get_weather']);
  });
});

describe('tools offered for the sources an owner has', () => {
  it('the phone tools, and the health reads that change nothing', async () => {
    const { HEALTH_READ_TOOLS, PHONE_TOOLS, healthSharedLately, noteHealthShared } = await import('../src/tools/loaded');
    expect(PHONE_TOOLS).toEqual(['get_device_context', 'get_screen_time', 'get_weather']);
    expect(HEALTH_READ_TOOLS).toEqual(expect.arrayContaining(['get_crs', 'get_master_metrics']));
    for (const name of HEALTH_READ_TOOLS) expect(TOOL_RECORDS[name as keyof typeof TOOL_RECORDS]).toMatchObject({ brain: 'health', claim: null });
    const store = kv();
    expect(healthSharedLately(store, 0)).toBe(false);
    noteHealthShared(store, 0);
    expect(healthSharedLately(store, 3 * 24 * 3_600_000 - 1)).toBe(true);
    expect(healthSharedLately(store, 3 * 24 * 3_600_000)).toBe(false);
  });
});
