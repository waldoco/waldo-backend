export default {
  // This mutation lane selects observable contract decisions: cap scope routing and the
  // durable counter source. The retired TracerDO journal/outbox state mapping it also covered
  // left with that pipeline; the gate and store are exercised directly.
  mutate: [
    'src/delivery-gate/gate.ts:63:1-79:4',
    'src/delivery-gate/store.ts:42:1-76:4',
  ],
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  coverageAnalysis: 'off',
  // Worker-test DO fixtures share the local harness process, so mutation cases must stay serial.
  concurrency: 1,
  vitest: {
    configFile: 'vitest.delivery-gate.config.ts',
    related: false,
  },
  reporters: ['clear-text'],
  thresholds: {
    high: 100,
    low: 100,
    break: 100,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
