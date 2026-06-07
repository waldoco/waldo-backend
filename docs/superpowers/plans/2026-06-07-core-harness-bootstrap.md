# Core Harness Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the first backend harness slice: consume `@pin4sf/waldo-types@^0.2.0`, update Worker toolchain types, and boot a minimal Cloudflare Worker with `/health`.

**Architecture:** Keep this PR small and staging-safe. `HEY-112` owns dependency/typecheck cleanup; `HEY-71` owns the Worker package, Wrangler config, `/health`, and a deliberately named auth stub. Durable Object, R2, AI Gateway, run journal, and real JWT verification stay out of this slice because those are owned by later tickets.

**Tech Stack:** npm workspaces, TypeScript strict mode, Vitest, Wrangler 4.x, `@cloudflare/workers-types`, `@pin4sf/waldo-types`, Cloudflare Workers.

---

## Current State

- PR #2 / `HEY-9` is merged into `beta` at `b22378281d109565df155fb55edb087d4b71c95f`.
- Staging Supabase is `gororukpipahvpvsydwz`; production Supabase is `atywijhgfevryxhkemfu`.
- Current branch for this work is `codex/hey-112-71-core-harness`, based on `origin/beta`.
- Root `package.json` still depends on stale `@waldo/types@1.0.0`.
- Existing Worker config is at `cloudflare/waldo-agent/wrangler.toml`, but `HEY-71` expects `cloudflare/waldo-worker/`.
- Existing Worker config contains stale production Supabase URL and a service-role-in-DO comment that conflicts with repo rules.

## File Structure

- Modify `package.json`: root workspace scripts and removal of stale `@waldo/types`.
- Create `package-lock.json`: npm lockfile produced by root `npm install`.
- Modify `tsconfig.json`: root base TS config only; no stale `@waldo/types` path alias.
- Move `cloudflare/waldo-agent/wrangler.toml` to `cloudflare/waldo-worker/wrangler.toml`: Worker-only config for `HEY-71`.
- Create `cloudflare/waldo-worker/package.json`: Worker package dependencies, scripts, and toolchain versions.
- Create `cloudflare/waldo-worker/tsconfig.json`: strict Worker TS config extending the root.
- Create `cloudflare/waldo-worker/src/auth.ts`: explicitly local auth stub used by tests and future routing tests.
- Create `cloudflare/waldo-worker/src/index.ts`: Worker fetch handler and `/health` route.
- Create `cloudflare/waldo-worker/src/index.test.ts`: health route, 404, and auth-stub tests.
- Create `cloudflare/waldo-worker/ENV.md`: non-secret environment contract including `WALDO_WORKER_URL`.

## Task 1: Baseline the Broken Dependency State

**Files:**
- Read: `package.json`
- Read: `tsconfig.json`

- [ ] **Step 1: Confirm the stale package is still present**

Run:

```bash
rg '@waldo/types|@pin4sf/waldo-types' package.json tsconfig.json cloudflare supabase
```

Expected: `package.json` contains `@waldo/types`; `tsconfig.json` contains a stale `@waldo/types` path alias.

- [ ] **Step 2: Confirm install currently fails for the right reason**

Run:

```bash
npm install
```

Expected: FAIL because `@waldo/types@1.0.0` is not installable. If it fails for another reason, diagnose that before editing dependencies.

## Task 2: Convert the Repo to an npm Workspace

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Replace root package metadata and scripts**

Replace root `package.json` with:

```json
{
  "name": "waldo-backend",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "cloudflare/waldo-worker"
  ],
  "scripts": {
    "check": "npm run typecheck",
    "typecheck": "npm -w @pin4sf/waldo-worker run typecheck",
    "test": "npm -w @pin4sf/waldo-worker run test",
    "test:watch": "npm -w @pin4sf/waldo-worker run test:watch",
    "dev": "npm -w @pin4sf/waldo-worker run dev",
    "deploy:staging": "npm -w @pin4sf/waldo-worker run deploy:staging",
    "deploy:prod": "npm -w @pin4sf/waldo-worker run deploy:production",
    "supabase:push": "supabase db push"
  }
}
```

- [ ] **Step 2: Remove the stale root path alias**

Replace root `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

- [ ] **Step 3: Re-scan for stale package references**

Run:

```bash
rg '@waldo/types@1.0.0|@waldo/types' package.json tsconfig.json cloudflare supabase
```

Expected: no matches.

## Task 3: Create the Worker Package

**Files:**
- Create: `cloudflare/waldo-worker/package.json`
- Create: `cloudflare/waldo-worker/tsconfig.json`

- [ ] **Step 1: Add the Worker package manifest**

Create `cloudflare/waldo-worker/package.json`:

```json
{
  "name": "@pin4sf/waldo-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "wrangler dev --config wrangler.toml",
    "deploy:staging": "wrangler deploy --config wrangler.toml --env staging",
    "deploy:production": "wrangler deploy --config wrangler.toml --env production",
    "pack": "npm pack --dry-run"
  },
  "dependencies": {
    "@pin4sf/waldo-types": "^0.2.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260607.1",
    "typescript": "^5.4.0",
    "vitest": "^4.1.8",
    "wrangler": "^4.98.0"
  }
}
```

- [ ] **Step 2: Add the Worker TypeScript config**

Create `cloudflare/waldo-worker/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types"],
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install dependencies from the repo root**

Run:

```bash
npm install
```

Expected: PASS and a root `package-lock.json` is created.

## Task 4: Replace Stale Wrangler Config with HEY-71 Config

**Files:**
- Move: `cloudflare/waldo-agent/wrangler.toml` -> `cloudflare/waldo-worker/wrangler.toml`

- [ ] **Step 1: Move the config to the ticket-owned path**

Move `cloudflare/waldo-agent/wrangler.toml` to `cloudflare/waldo-worker/wrangler.toml`.

- [ ] **Step 2: Replace the config with the HEY-71 scope**

Use this exact config:

```toml
name = "waldo-worker"
main = "src/index.ts"
compatibility_date = "2026-06-07"

[observability]
enabled = true
head_sampling_rate = 1

[vars]
ENVIRONMENT = "local"
SUPABASE_URL = "https://gororukpipahvpvsydwz.supabase.co"

[env.staging]
name = "waldo-worker-staging"
vars = { ENVIRONMENT = "staging", SUPABASE_URL = "https://gororukpipahvpvsydwz.supabase.co" }

[env.production]
name = "waldo-worker-production"
vars = { ENVIRONMENT = "production", SUPABASE_URL = "https://atywijhgfevryxhkemfu.supabase.co" }
```

No DO, R2, AI Gateway, or secret bindings belong in this first config. They are added by `HEY-72`, `HEY-8`, and `HEY-17`.

- [ ] **Step 3: Remove the old empty folder if it has no files**

Run:

```bash
find cloudflare/waldo-agent -type f
```

Expected: no files. Remove the empty directory.

## Task 5: Add the Minimal Worker Runtime

**Files:**
- Create: `cloudflare/waldo-worker/src/auth.ts`
- Create: `cloudflare/waldo-worker/src/index.ts`

- [ ] **Step 1: Add the local auth stub**

Create `cloudflare/waldo-worker/src/auth.ts`:

```ts
export type AuthContext = {
  userId: string;
};

const LOCAL_BEARER_PREFIX = "Bearer local-user:";

export function parseLocalAuthStub(request: Request): AuthContext | null {
  const authorization = request.headers.get("Authorization");

  if (!authorization?.startsWith(LOCAL_BEARER_PREFIX)) {
    return null;
  }

  const userId = authorization.slice(LOCAL_BEARER_PREFIX.length).trim();

  if (userId.length === 0) {
    return null;
  }

  return { userId };
}
```

- [ ] **Step 2: Add the Worker fetch handler**

Create `cloudflare/waldo-worker/src/index.ts`:

```ts
export type Env = {
  ENVIRONMENT: string;
  SUPABASE_URL: string;
};

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");

  return Response.json(body, {
    ...init,
    headers
  });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      status: "ok",
      service: "waldo-worker",
      environment: env.ENVIRONMENT,
      supabaseUrlConfigured: env.SUPABASE_URL.length > 0
    });
  }

  return json({ error: "not_found" }, { status: 404 });
}

export default {
  fetch: handleRequest
} satisfies ExportedHandler<Env>;
```

## Task 6: Add Focused Tests

**Files:**
- Create: `cloudflare/waldo-worker/src/index.test.ts`
- Create: `cloudflare/waldo-worker/src/types-contract.test.ts`

- [ ] **Step 1: Add route and auth-stub tests**

Create `cloudflare/waldo-worker/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseLocalAuthStub } from "./auth";
import { type Env, handleRequest } from "./index";

const env: Env = {
  ENVIRONMENT: "test",
  SUPABASE_URL: "https://gororukpipahvpvsydwz.supabase.co"
};

describe("waldo-worker", () => {
  it("returns health status", async () => {
    const response = await handleRequest(new Request("https://worker.test/health"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "waldo-worker",
      environment: "test",
      supabaseUrlConfigured: true
    });
  });

  it("returns 404 for unknown routes", async () => {
    const response = await handleRequest(new Request("https://worker.test/missing"), env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("parses the local auth stub format", () => {
    const request = new Request("https://worker.test/run", {
      headers: { Authorization: "Bearer local-user:user_123" }
    });

    expect(parseLocalAuthStub(request)).toEqual({ userId: "user_123" });
  });

  it("rejects missing auth in the local auth stub", () => {
    const request = new Request("https://worker.test/run");

    expect(parseLocalAuthStub(request)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests**

Create `cloudflare/waldo-worker/src/types-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runRecordSchema, toolNameSchema, zoneSchema } from "@pin4sf/waldo-types";

describe("@pin4sf/waldo-types contract", () => {
  it("resolves the published runtime spine exports", () => {
    expect(typeof toolNameSchema.parse).toBe("function");
    expect(typeof runRecordSchema.parse).toBe("function");
    expect(typeof zoneSchema.parse).toBe("function");
  });
});
```

- [ ] **Step 2: Run the tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

## Task 7: Add the Environment Contract

**Files:**
- Create: `cloudflare/waldo-worker/ENV.md`

- [ ] **Step 1: Add the Worker environment doc**

Create `cloudflare/waldo-worker/ENV.md`:

```md
# Waldo Worker Environment

## Non-secret vars

- `ENVIRONMENT`: `local`, `staging`, or `production`.
- `SUPABASE_URL`: Supabase project URL for the target environment.
- `WALDO_WORKER_URL`: Public Worker URL consumed by app/backend callers after deploy.

## Secrets

No Worker secrets are required for HEY-71.

Do not add `SUPABASE_SERVICE_ROLE_KEY` to this Worker. Service-role access is Edge Function/admin only; the Durable Object agent loop must not hold it.
```

## Task 8: Verify Wrangler and Package Boundary

**Files:**
- Read: `cloudflare/waldo-worker/wrangler.toml`
- Read: `cloudflare/waldo-worker/package.json`

- [ ] **Step 1: Validate Wrangler config**

Run:

```bash
npm -w @pin4sf/waldo-worker exec wrangler deploy --dry-run --config wrangler.toml
```

Expected: PASS. If Wrangler rejects `deploy --dry-run`, use:

```bash
npm -w @pin4sf/waldo-worker exec wrangler dev --config wrangler.toml --local
```

Then request `/health`:

```bash
curl -i http://localhost:8787/health
```

Expected: HTTP 200 with `status: "ok"`.

- [ ] **Step 2: Verify package dry run**

Run:

```bash
npm -w @pin4sf/waldo-worker run pack
```

Expected: PASS and no unexpected files in the tarball.

- [ ] **Step 3: Verify stale names are gone**

Run:

```bash
rg '@waldo/types|waldo-agent|SUPABASE_SERVICE_ROLE_KEY|ogjgbudoedwxebxfgxpa' package.json package-lock.json tsconfig.json cloudflare
```

Expected: no matches except `SUPABASE_SERVICE_ROLE_KEY` in `ENV.md` as the explicit "do not add" warning.

## Task 9: Update Linear and Open the PR

**Files:**
- No file changes.

- [ ] **Step 1: Move `HEY-112` to In Progress if not already moved**

Use Linear state `In Progress`.

- [ ] **Step 2: Comment on `HEY-112`**

Use:

```md
Started backend slice on branch `codex/hey-112-71-core-harness`.

Scope for this PR:
- replace stale `@waldo/types@1.0.0` with `@pin4sf/waldo-types@^0.2.0`
- make backend install/typecheck clean
- keep app migration and ADR-0029 cross-repo CI gate tracked as separate follow-up work if this backend-only PR does not touch `waldo-app` or `waldo-types`
```

- [ ] **Step 3: Comment on `HEY-71`**

Use:

```md
Started minimal Worker harness on branch `codex/hey-112-71-core-harness`.

Scope for this PR:
- `cloudflare/waldo-worker/wrangler.toml`
- `/health`
- strict Worker TypeScript package
- local auth stub shape only

Out of scope remains DO/R2/AI Gateway bindings, real JWT verification, and run journal.
```

- [ ] **Step 4: Commit**

Run:

```bash
git status --short
git add package.json package-lock.json tsconfig.json cloudflare/waldo-worker docs/superpowers/plans/2026-06-07-core-harness-bootstrap.md
git commit -m "feat(infra): bootstrap HEY-112 HEY-71 worker harness"
```

- [ ] **Step 5: Push and open a PR to beta**

Run:

```bash
git push -u origin codex/hey-112-71-core-harness
gh pr create --base beta --head codex/hey-112-71-core-harness --title "feat(infra): HEY-112 HEY-71 worker harness bootstrap" --body "Closes HEY-71

Partially addresses HEY-112 for waldo-backend.

## Summary
- migrate backend dependency from @waldo/types to @pin4sf/waldo-types
- add minimal Cloudflare Worker package and /health route
- update Worker toolchain to current Wrangler and workers-types

## Verification
- npm install
- npm run typecheck
- npm test
- npm -w @pin4sf/waldo-worker run pack
- wrangler dry-run or local /health smoke"
```

## Follow-on Ticket Order

1. `HEY-72`: add `WaldoAgent` Durable Object shell and alarm entrypoint.
2. `HEY-10`: add DO SQLite base migrations for memory/runtime tables, excluding `runs` and `outbox`.
3. `HEY-11`: add `AuditedDB` enforcement once the DO SQLite access seam exists.
4. `HEY-110`: add run journal and transactional outbox.
5. `HEY-12` and `HEY-78`: hook registry and ToolDispatcher ACL.
6. `HEY-17`: LLMProvider through Cloudflare AI Gateway.
7. `HEY-111`: trace/eval/observability spine, then Langfuse/OpenTelemetry export depth.
8. `HEY-102`: CRS engine after schema, types, and audited persistence are stable.
9. `HEY-64`: Google Calendar OAuth and sync Edge Function after auth/EF patterns are stable.
10. `HEY-18`: Telegram adapter after outbox and shared thread identity exist.

## Supabase GitHub Integration

The native Supabase GitHub integration still requires account-level OAuth in the Supabase Dashboard. Codex can verify repo branches, environment variables, and migrations, but cannot authorize the Supabase GitHub app for the user's account through CLI/MCP.

Use the Supabase Dashboard flow:

1. Project Settings -> Integrations.
2. Under GitHub Integration, authorize GitHub.
3. Choose repo `Pin4sf/waldo-backend`.
4. Set working directory to `.` because `supabase/` is at repo root.
5. For staging, connect branch `beta`.
6. For production, connect branch `main`.
7. Enable production deploy only on the production project.

Supabase docs confirm that the working directory should be `.` when the `supabase/` folder is at repository root and that migrations under `supabase/migrations` are applied automatically by the integration.

## Self-review

- Spec coverage: `HEY-112` backend dependency migration is covered; `waldo-app` and ADR-0029 cross-repo CI gate are explicitly left for a separate cross-repo PR because this repo cannot modify those workspaces. `HEY-71` files and acceptance criteria are covered.
- Placeholder scan: no `TBD`, `TODO`, or "implement later" steps are present.
- Type consistency: `Env`, `handleRequest`, and `parseLocalAuthStub` names are defined before use and reused consistently.

## Review Follow-up Applied

- `parseLocalAuthStub` is disabled outside `ENVIRONMENT=local` and only accepts UUID-shaped user IDs.
- `src/env.ts` validates required Worker config and rejects accidental `SUPABASE_SERVICE_ROLE_KEY` bindings.
- `WALDO_WORKER_URL` is now represented in `Env` and `wrangler.toml` vars as an explicit placeholder.
- `/health` now returns 405 for non-GET methods and 500 for misconfigured runtime env.
