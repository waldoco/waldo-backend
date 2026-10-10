import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { scanSource } from '../guards/guard-health-leak.mjs';
const violations = source => scanSource(source);
test('raw numeric assignments, label/value pairs and interpolations remain blocked', () => {
  for (const source of ['const hrv = 42;', 'const hrv = .42;', 'const snapshot = { name: "hrv", value: 42 };', 'const value = `HRV ${42}`;']) assert.ok(violations(source).length, source);
});
test('actual logging, telemetry, journal/outbox/R2 and offload calls block private values', () => {
  for (const source of ['console.log("hrv", 42);', 'logger.info("hrv", reading.value);', 'console.log({metric:"overnight_hrv",value:measurement});', 'journal.append({metric:"physical_load",value:measurement});', 'log({hrv: reading.value});', 'logger.info(hrvMs);', 'span.setAttribute("hrv", reading.hrv);', 'outbox.push({hrv: measured});', 'journal.append({name:"hrv",value:reading.value});', 'r2.put(key, JSON.stringify({sleep_minutes: reading.value}));', 'offloadStore.put(hrv);']) assert.ok(violations(source).length, source);
});
test('math variables and local arrays do not become sinks through lexical proximity', () => {
  for (const source of ['const metric = "hrv"; const result = normalize(metric, 6);', 'components.push(component(metric, signal, value, weight)); const limit = 14;', 'const hasMetric = metric => metrics.has(metric); const age = 36 * 3600000;', 'missingNights.push(nightDay); const coverage = observed / 14;']) assert.deepEqual(violations(source), [], source);
});
test('only the exact reviewed dimensionless coefficient catalog is exempt', () => {
  const file = resolve('packages/runtime/src/health/calculations.ts');
  const source = 'const CANDIDATE_WEIGHTS = { recovery: { hrv: .3, resting_heart_rate: .2 } };';
  assert.deepEqual(scanSource(source, file), []);
  assert.ok(scanSource(source, resolve('fixture.ts')).length);
  assert.ok(scanSource('const CANDIDATE_WEIGHTS = { hrv:42 };', file).length);
  assert.ok(scanSource('const CANDIDATE_WEIGHTS = { hrv:-.2 };', file).length);
  assert.ok(scanSource(source + '\nconsole.log(hrv);', file).length);
});
test('static enum/count metadata remain permitted without laundering a value label', () => {
  for (const source of ['log({phase:"health_read",count:42});', 'logger.info("hrv source unavailable");', 'trace.emit({source:"hrv",count:42});']) assert.deepEqual(violations(source), [], source);
  assert.ok(violations('logger.info({name:"hrv",value:payload});').length);
});
