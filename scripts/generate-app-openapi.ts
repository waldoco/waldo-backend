import { writeFileSync } from 'node:fs';
import { buildAppOpenApiV1 } from '../packages/contracts/src/app/agent';
writeFileSync(new URL('../packages/contracts/openapi/waldo-app-v1.json', import.meta.url), `${JSON.stringify(buildAppOpenApiV1(), null, 2)}\n`);
