export default {
  // Deterministic ordering is an observable security/provenance decision. This narrow
  // lane mutates only the binary UTF-16 comparator used by prompt, source-ref, and context-ref
  // ordering; the public composition permutation test must kill every selected mutant.
  mutate: ['src/context-composer/canonical.ts:7:1-7:34'],
  // `left <= right` is equivalent here because the preceding equality return has already
  // excluded equal values. This lane measures the non-equivalent branch outcomes instead.
  mutator: {
    excludedMutations: ['EqualityOperator'],
  },
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  coverageAnalysis: 'off',
  concurrency: 1,
  vitest: {
    configFile: 'vitest.context-composer.config.ts',
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
