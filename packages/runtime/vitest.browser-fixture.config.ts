// Local engine-neutral HTTP fixture. Deliberately separate from Workers/scenario pools.
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/browser-workspace-fixture.test.ts"],
  },
});
