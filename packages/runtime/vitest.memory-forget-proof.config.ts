import config from './vitest.owner-ingress.config';
export default { ...config, test: { ...config.test, include: ['test/memory-forget-do-provider.test.ts'] } };
