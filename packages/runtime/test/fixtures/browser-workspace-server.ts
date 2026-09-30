// Local synthetic conformance only. No production effect/receipt authority or auth state.
import { createServer, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
export type FixtureReceipt = Readonly<{
  version: 1;
  provenance: "synthetic_only";
  runId: string;
  opaqueId: string;
  bindingDigest: string;
  state: "acknowledged_fixture";
  observedAt: string;
  downloadDigest: string;
}>;
const DOWNLOAD = Buffer.from("Synthetic workspace download.\nNo user data.\n");
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const pairs = (value: unknown): [string, string][] => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("invalid flat binding");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 24) throw Error("binding capacity");
  for (const [key, text] of entries)
    if (
      !key ||
      key.length > 80 ||
      forbidden.has(key) ||
      typeof text !== "string" ||
      !text ||
      text.length > 1000
    )
      throw Error("invalid binding key/value");
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
};
// Detect duplicate JSON object keys before JSON.parse can silently overwrite them.
const strictJson = (text: string): unknown => {
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i] ?? "") && i < text.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw Error("unterminated string");
  };
  const value = (): void => {
    ws();
    if (text[i] === "{") {
      i++;
      const keys = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      while (true) {
        ws();
        if (text[i] !== '"') throw Error("object key");
        const key = string();
        if (keys.has(key) || forbidden.has(key))
          throw Error("duplicate/pollution key");
        keys.add(key);
        ws();
        if (text[i++] !== ":") throw Error("colon");
        value();
        ws();
        const end = text[i++];
        if (end === "}") return;
        if (end !== ",") throw Error("comma");
      }
    } else if (text[i] === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      while (true) {
        value();
        ws();
        const end = text[i++];
        if (end === "]") return;
        if (end !== ",") throw Error("comma");
      }
    } else if (text[i] === '"') {
      string();
    } else {
      const match =
        /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
          text.slice(i),
        );
      if (!match) throw Error("value");
      i += match[0].length;
    }
  };
  value();
  ws();
  if (i !== text.length) throw Error("trailing data");
  return JSON.parse(text);
};
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const createFixture = async ({
  runId,
  approvedBinding,
  nonceFactory,
  clock,
}: {
  runId: string;
  approvedBinding: Readonly<Record<string, string>>;
  nonceFactory: () => string;
  clock: () => Date;
}) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw Error("invalid runId");
  const entries = pairs(approvedBinding);
  const binding = Object.fromEntries(entries);
  const bindingDigest = digest(JSON.stringify(entries));
  const token = nonceFactory();
  const opaqueId = nonceFactory();
  if (
    !/^[A-Za-z0-9_-]{16,160}$/.test(token) ||
    !/^[A-Za-z0-9_-]{16,160}$/.test(opaqueId) ||
    token === opaqueId
  )
    throw Error("invalid distinct host nonces");
  let consumed = false,
    closed = false,
    receipt: FixtureReceipt | null = null,
    baseUrl = "";
  const prefix = `/fixture/${runId}`;
  const readBody = async (req: IncomingMessage) => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 16384) throw Error("body_limit");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const server = createServer(async (req, res) => {
    const send = (
      status: number,
      body: string | Buffer,
      type = "application/json",
    ) => {
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(body);
    };
    if (
      closed ||
      req.headers.host !== new URL(baseUrl).host ||
      (req.headers.origin !== undefined && req.headers.origin !== baseUrl)
    ) {
      send(403, "denied");
      return;
    }
    if (req.method === "POST" && req.headers.origin !== baseUrl) {
      send(403, "origin required");
      return;
    }
    const path = req.url ?? "";
    if (req.method === "GET" && path === `${prefix}/page`) {
      const state = JSON.stringify({ runId, token, binding }).replace(
        /</g,
        "\\u003c",
      );
      send(
        200,
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture conformance</title><style>body{font:16px system-ui;background:#f5f5f2;color:#172a2b;margin:0;padding:24px}main{max-width:640px;margin:auto;background:white;padding:24px;border-radius:12px}h1{font-size:28px}label{display:block;margin:16px 0}input{box-sizing:border-box;width:100%;padding:10px;border:1px solid #819493;border-radius:5px;font:inherit}button,a{font:inherit}button{background:#185a52;color:white;padding:12px 18px;border:0;border-radius:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{display:inline-block;margin-top:16px}</style><main><p>LOCAL SYNTHETIC ONLY</p><h1>Fixture conformance</h1><p>No messages, purchases or real accounts. A page acknowledgment is not verified completion.</p><form id="form">${entries.map(([key, text]) => `<label>${escape(key)}<input name="${escape(key)}" value="${escape(text)}" readonly></label>`).join("")}<button id="submit">Submit synthetic fixture</button></form><pre id="result" role="status">Not submitted.</pre><a href="${prefix}/download" download="synthetic-workspace.txt">Download synthetic text</a><script id="fixture-state" type="application/json">${state}</script><script>const state=JSON.parse(document.getElementById('fixture-state').textContent);document.getElementById('form').onsubmit=async(event)=>{event.preventDefault();document.getElementById('submit').disabled=true;try{const response=await fetch('${prefix}/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state)});document.getElementById('result').textContent=await response.text();}catch{document.getElementById('result').textContent='Response lost. Outcome unknown. Read host ledger; do not resubmit.';}};</script></main></html>`,
        "text/html;charset=utf-8",
      );
      return;
    }
    if (req.method === "GET" && path === `${prefix}/download`) {
      res.setHeader(
        "content-disposition",
        'attachment; filename="synthetic-workspace.txt"',
      );
      send(200, DOWNLOAD, "text/plain;charset=utf-8");
      return;
    }
    if (
      req.method === "GET" &&
      path === `${prefix}/receipt/${opaqueId}` &&
      receipt
    ) {
      send(200, JSON.stringify(receipt));
      return;
    }
    if (req.method !== "POST" || path !== `${prefix}/submit`) {
      send(404, "not found");
      return;
    }
    try {
      if (req.headers["content-type"] !== "application/json") {
        send(415, "json required");
        return;
      }
      const input = strictJson(await readBody(req)) as {
        runId?: unknown;
        token?: unknown;
        binding?: unknown;
      };
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "binding,runId,token"
      ) {
        send(400, "invalid submit schema");
        return;
      }
      if (
        input.runId !== runId ||
        input.token !== token ||
        JSON.stringify(pairs(input.binding)) !== JSON.stringify(entries) ||
        consumed
      ) {
        send(409, "binding/token denied");
        return;
      }
      // No await between consume and effect/receipt: exactly one concurrent winner.
      consumed = true;
      receipt = {
        version: 1,
        provenance: "synthetic_only",
        runId,
        opaqueId,
        bindingDigest,
        state: "acknowledged_fixture",
        observedAt: clock().toISOString(),
        downloadDigest: digest(DOWNLOAD),
      };
      send(200, JSON.stringify(receipt));
    } catch (error) {
      send(
        error instanceof Error && error.message === "body_limit" ? 413 : 400,
        "invalid body",
      );
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("no loopback address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    pageUrl: `${baseUrl}${prefix}/page`,
    hostReadback: (run: string, id: string): FixtureReceipt | null =>
      !closed && run === runId && id === opaqueId && receipt
        ? structuredClone(receipt)
        : null,
    close: async () => {
      if (closed) return;
      closed = true;
      receipt = null;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
};
