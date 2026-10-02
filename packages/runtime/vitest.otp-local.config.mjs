import { defineConfig } from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['test/phone-verification.test.ts','test/signup-phone-proof.test.ts','test/console-signup*.test.ts','test/identity-request-timeout.test.ts'],fileParallelism:false}});
