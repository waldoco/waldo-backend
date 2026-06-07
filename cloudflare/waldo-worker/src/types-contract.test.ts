import { describe, expect, it } from "vitest";
import { runRecordSchema, toolNameSchema, zoneSchema } from "@pin4sf/waldo-types";

describe("@pin4sf/waldo-types contract", () => {
  it("resolves the published runtime spine exports", () => {
    expect(typeof toolNameSchema.parse).toBe("function");
    expect(typeof runRecordSchema.parse).toBe("function");
    expect(typeof zoneSchema.parse).toBe("function");
  });
});
