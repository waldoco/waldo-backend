import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createFixture } from "./fixtures/browser-workspace-server";
const binding = {
  recipient: "fixture@example.invalid",
  item: "Synthetic report",
  total: "USD 0.00",
};
const fixtures: Awaited<ReturnType<typeof createFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});
const fixture = async () => {
  const f = await createFixture({
    runId: "run-one",
    approvedBinding: binding,
    nonceFactory: () => crypto.randomUUID(),
    clock: () => new Date("2026-10-01T00:00:00Z"),
  });
  fixtures.push(f);
  return f;
};
const token = async (f: Awaited<ReturnType<typeof createFixture>>) => {
  const page = await (await fetch(f.pageUrl)).text();
  return JSON.parse(
    page.match(
      /<script id="fixture-state" type="application\/json">(.*?)<\/script>/s,
    )![1]!,
  ).token as string;
};
const submit = (
  f: Awaited<ReturnType<typeof createFixture>>,
  payload: unknown,
  headers = {},
) =>
  fetch(`${f.baseUrl}/fixture/run-one/submit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: f.baseUrl,
      ...headers,
    },
    body: JSON.stringify(payload),
  });
it("host creates one synthetic receipt before response; replay/concurrency cannot repeat effect", async () => {
  const f = await fixture();
  const t = await token(f);
  const input = { runId: "run-one", token: t, binding };
  const responses = await Promise.all([submit(f, input), submit(f, input)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const ack = (await responses.find((r) => r.status === 200)!.json()) as {
    opaqueId: string;
  };
  const receipt = f.hostReadback("run-one", ack.opaqueId);
  expect(receipt).toMatchObject({
    version: 1,
    provenance: "synthetic_only",
    runId: "run-one",
    state: "acknowledged_fixture",
    observedAt: "2026-10-01T00:00:00.000Z",
  });
  expect(receipt!.bindingDigest).toBe(
    createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(binding).sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest("hex"),
  );
  expect((await submit(f, input)).status).toBe(409);
  expect(f.hostReadback("other", ack.opaqueId)).toBeNull();
  expect(f.hostReadback("run-one", "forged")).toBeNull();
  const bytes = await (
    await fetch(`${f.baseUrl}/fixture/run-one/download`)
  ).arrayBuffer();
  expect(receipt!.downloadDigest).toBe(
    createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
  );
});
it("complete exact binding rejects missing/added/case/value drift, foreign run/token and authority fields without consuming token", async () => {
  const f = await fixture();
  const t = await token(f);
  for (const changed of [
    { ...binding, total: "USD 1.00" },
    { recipient: binding.recipient, item: binding.item },
    { ...binding, extra: "x" },
    { ...binding, Recipient: binding.recipient },
    { ...binding, total: "usd 0.00" },
  ])
    expect(
      (await submit(f, { runId: "run-one", token: t, binding: changed }))
        .status,
    ).toBe(409);
  for (const payload of [
    { runId: "other", token: t, binding },
    { runId: "run-one", token: "foreign", binding },
    {
      runId: "run-one",
      token: t,
      binding,
      receipt: { state: "verified_with_receipt" },
    },
  ])
    expect((await submit(f, payload)).status).toBeGreaterThanOrEqual(400);
  expect(
    (await submit(f, { runId: "run-one", token: t, binding })).status,
  ).toBe(200);
});
it("rejects unsafe schema inputs and loopback Host/origin/path escapes; strict bounded body", async () => {
  for (const approvedBinding of [
    {},
    JSON.parse('{"__proto__":"pollution"}'),
    { x: "" },
  ])
    await expect(
      createFixture({
        runId: "run-one",
        approvedBinding,
        nonceFactory: () => crypto.randomUUID(),
        clock: () => new Date(),
      }),
    ).rejects.toThrow();
  const f = await fixture();
  expect(
    await new Promise<number>((resolve) => {
      const r = httpRequest(
        f.pageUrl,
        { headers: { host: "outside.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      r.end();
    }),
  ).toBe(403);
  expect(
    (await fetch(f.pageUrl, { headers: { origin: "https://outside.invalid" } }))
      .status,
  ).toBe(403);
  expect((await fetch(`${f.baseUrl}/fixture/other/page`)).status).toBe(404);
  expect(
    (await submit(f, {}, { origin: "https://outside.invalid" })).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${f.baseUrl}/fixture/run-one/submit`, {
        method: "POST",
        headers: { origin: f.baseUrl, "content-type": "application/json" },
        body: "x".repeat(16385),
      })
    ).status,
  ).toBe(413);
});
it("lost response is recovered only by host ledger; page-forged receipt never gains authority; close denies readback", async () => {
  const f = await fixture();
  const t = await token(f);
  const response = await submit(f, { runId: "run-one", token: t, binding });
  const { opaqueId } = (await response.json()) as { opaqueId: string };
  // Discard the HTTP receipt; authoritative recovery reads the retained host ledger only.
  expect(f.hostReadback("run-one", opaqueId)?.state).toBe(
    "acknowledged_fixture",
  );
  expect(f.hostReadback("run-one", "page-says-complete")).toBeNull();
  await f.close();
  expect(f.hostReadback("run-one", opaqueId)).toBeNull();
  await expect(fetch(f.pageUrl)).rejects.toThrow();
});
it("duplicate/pollution JSON keys are rejected before token use; binding copied and case-sensitive", async () => {
  const mutable = { ...binding };
  let n = 0;
  const f = await createFixture({
    runId: "run-one",
    approvedBinding: mutable,
    nonceFactory: () => `fixture-host-nonce-${++n}`,
    clock: () => new Date(0),
  });
  fixtures.push(f);
  mutable.total = "changed";
  const t = await token(f);
  const url = `${f.baseUrl}/fixture/run-one/submit`;
  for (const body of [
    `{"runId":"other","runId":"run-one","token":"${t}","binding":${JSON.stringify(binding)}}`,
    `{"runId":"run-one","token":"${t}","binding":{"__proto__":"x"}}`,
  ])
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { origin: f.baseUrl, "content-type": "application/json" },
          body,
        })
      ).status,
    ).toBe(400);
  expect(
    (await submit(f, { runId: "run-one", token: t, binding })).status,
  ).toBe(200);
});
it("actual discarded transport response leaves host custody and cannot dispatch a second effect", async () => {
  let n = 0;
  const f = await createFixture({
    runId: "run-one",
    approvedBinding: binding,
    nonceFactory: () => `lost-host-nonce-${++n}`,
    clock: () => new Date(0),
  });
  fixtures.push(f);
  const t = await token(f);
  const input = { runId: "run-one", token: t, binding };
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      `${f.baseUrl}/fixture/run-one/submit`,
      {
        method: "POST",
        headers: { origin: f.baseUrl, "content-type": "application/json" },
      },
      (response) => {
        response.destroy();
        resolve();
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(input));
  });
  expect(f.hostReadback("run-one", "lost-host-nonce-2")?.state).toBe(
    "acknowledged_fixture",
  );
  expect((await submit(f, input)).status).toBe(409);
});
it("invalid run IDs/nonces, primitive/nested/whitespace bindings and foreign receipt routes deny authority", async () => {
  for (const runId of ["", "../foreign", "a".repeat(81)])
    await expect(
      createFixture({
        runId,
        approvedBinding: binding,
        nonceFactory: () => crypto.randomUUID(),
        clock: () => new Date(),
      }),
    ).rejects.toThrow("runId");
  await expect(
    createFixture({
      runId: "run-one",
      approvedBinding: binding,
      nonceFactory: () => "same-host-nonce-000",
      clock: () => new Date(),
    }),
  ).rejects.toThrow("nonces");
  const f = await fixture();
  const t = await token(f);
  for (const changed of [
    null,
    [],
    { ...binding, total: " USD 0.00" },
    { ...binding, total: { value: "USD 0.00" } },
  ])
    expect(
      (await submit(f, { runId: "run-one", token: t, binding: changed }))
        .status,
    ).toBeGreaterThanOrEqual(400);
  const ack = (await (
    await submit(f, { runId: "run-one", token: t, binding })
  ).json()) as { opaqueId: string };
  expect(
    (await fetch(`${f.baseUrl}/fixture/foreign/receipt/${ack.opaqueId}`))
      .status,
  ).toBe(404);
  expect(
    (await fetch(`${f.baseUrl}/fixture/run-one/receipt/forged`)).status,
  ).toBe(404);
  const receipt = f.hostReadback("run-one", ack.opaqueId)!;
  const changed = receipt as { state: string };
  changed.state = "verified_with_receipt";
  expect(f.hostReadback("run-one", ack.opaqueId)!.state).toBe(
    "acknowledged_fixture",
  );
});
