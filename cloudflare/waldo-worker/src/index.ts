import { type Env } from "./env";
import { handleRequest } from "./worker";

export { WaldoAgent } from "./waldo-agent-do";
export { handleRequest };

export default {
  fetch: handleRequest
} satisfies ExportedHandler<Env>;
