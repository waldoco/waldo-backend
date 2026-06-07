<!-- MIRRORED FROM waldo-brain/.claude/rules/security-checklist.md @ e09f89f49985 -->
<!-- Do not edit locally. Edit canonical in waldo-brain, then resync. -->
<!-- Sync ritual: see waldo-brain/.claude/rules/MIRROR-SYNC.md -->

# Security Checklist — Universal

> **Canonical source:** `waldo-brain/.claude/rules/security-checklist.md` @ `e09f89f49985`. This file is a verbatim mirror per [[0063-canonical-rule-files-mirroring|ADR-0063]]. Edits land canonical-first; do not edit locally.

> RFC2119 keywords (**MUST**, **SHOULD**, **MAY**, etc.) apply per [`posture.md`](posture.md).

> Adapted from the Atlan `AGENTS.md` security baseline. Applies to every change in every Waldo repo, regardless of stack. Composes with each repo's repo-specific NEVER list in `CLAUDE.md`.

> **Tags:** `[MUST]` = required · `[REDLINE]` = forbidden · `[SHOULD]` = best practice.

---

## How to use this file

1. **Every change:** apply the 5 Always-Check Invariants.
2. **Based on what you're changing:** apply the relevant Conditional Checks.
3. **When you find issues:** use the Severity & Response rules.

---

## Always-Check Invariants — every change

These five **MUST** pass on every change. No exceptions.

1. **[MUST] No secrets** in code, config, logs, CI output, or `.env` files in version control.
2. **[MUST] Authentication & authorization must be real** — every protected endpoint **MUST** verify identity (JWT, OAuth, API key, session token, OIDC, or whatever mechanism the service uses) and enforce permissions. No "phantom auth" (imported but unused middleware).
3. **[MUST] No wildcards** — no `CORS: *`, no `Action:"*"`, no RBAC `resources:["*"]`, no GitHub `write-all`.
4. **[MUST] No untrusted execution** — no `eval`, no unsafe deserialisation, no command injection, no untrusted input in CI `run:` blocks.
5. **[MUST] Pin supply chain** — GitHub Actions pinned to full SHA, container images pinned to version/SHA, no `latest`. Verify deps exist and are reputable.

---

## Conditional Checks

Apply when the described pattern is present in the change:

| When you see... | Check |
|---|---|
| **DB queries** | **[MUST]** Parameterised only; scoped to tenant/user/org. **[REDLINE]** String concatenation with user input. |
| **Auth/session code** | **[MUST]** Validate credentials properly (JWT signature + claims, API key lookup, OAuth token introspection, session validity). **[MUST]** Tokens/sessions **MUST** expire. **[SHOULD]** httpOnly + secure + sameSite cookies for browser sessions. **[SHOULD]** Use established auth libraries, not hand-rolled crypto. |
| **New API endpoint** | **[MUST]** Ships with authentication, authorisation, input validation, and rate limiting — not as a follow-up. Add tenant/user scoping if multi-tenant. |
| **Error responses** | **[MUST]** Generic to clients. **[REDLINE]** Stack traces, SQL, file paths, internal IPs in client responses. |
| **Outbound HTTP with user input** | **[MUST]** Allowlist hosts; block internal/metadata IPs (10.x, 172.16-31.x, 192.168.x, 169.254.169.254, localhost). |
| **Logging code** | **[REDLINE]** Never log tokens, cookies, secrets, Authorization headers, full request/response bodies, raw health values (HRV, HR, SpO2, sleep hours, weight, BP). **[SHOULD]** Include contextual identifiers (user, request ID) in structured logs for audit. |
| **Dependency changes** | **[MUST]** Block CRITICAL/HIGH CVEs; flag MEDIUM. Check for typosquatting (new package, low downloads, similar name). Verify lockfile matches manifest. |
| **`.env` files** | **[MUST]** In `.gitignore`. `.env.example` carries placeholders only. Block real secrets at PR time. |
| **CI/CD workflows** | **[MUST]** Pin actions to SHA. Minimum permissions. **[REDLINE]** PR metadata interpolated in `run:` blocks; `pull_request_target` with secrets + PR checkout; `write-all` permissions. |
| **Helm/K8s manifests** (where applicable — backend infra) | **[MUST]** `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `drop: ["ALL"]`. Least-privilege RBAC. **[REDLINE]** Secrets in `values.yaml`; `privileged: true`; `latest` tags. |
| **Shell scripts** | **[MUST]** `set -euo pipefail`. Quote variables. `mktemp` + cleanup trap. **[REDLINE]** `eval` with user input; `curl ... \| bash`; secrets in CLI args. |
| **Frontend code (waldo-app)** | **[REDLINE]** `dangerouslySetInnerHTML` / `v-html` / `innerHTML` with user-controlled data. **[MUST]** No tokens/secrets in `AsyncStorage` / `MMKV` / plain SQLite — SQLCipher only for health data. **[MUST]** Validate redirect targets against allowlist (prevent open redirects). **[MUST]** Sanitise rich text with a vetted library before rendering. **[SHOULD]** No source maps in production. **[SHOULD]** No PII, internal IDs, or debug data in client state/URLs. **[SHOULD]** `rel="noopener noreferrer"` on external links with `target="_blank"`. |
| **IaC (Terraform/Cloudflare config)** | **[MUST]** No public buckets. Encrypt at rest. Least-privilege IAM (no `Action:"*"`). **[SHOULD]** Minimise `0.0.0.0/0` ingress. |
| **AI/LLM code** | **[MUST]** No raw user input in system/privileged prompts — clear delimiters between instructions and user content. **[MUST]** Mask PII/secrets/health-values before sending to any LLM (Scribe sanitiser — ADR-0024). **[MUST]** Sanitise model output before rendering in UI (XSS risk). **[MUST]** Do not use LLM output for auth/authz decisions. **[MUST]** Do not send customer data to external LLMs without explicit consent + DPA. **[REDLINE]** Passing LLM output directly to `eval`, SQL, shell commands, or `innerHTML` — leads to code injection / command injection / SQLi / XSS. **[SHOULD]** Validate/filter model outputs before downstream use. **[SHOULD]** Log categories of data sent to LLMs (not raw content). **[SHOULD]** Rate-limit LLM API calls to prevent abuse + cost overrun. |
| **Docker / containers** | **[MUST]** Non-root user. Pin base image versions. **[REDLINE]** Secrets in build layers; `privileged: true`. |
| **Code references / imports** | **[MUST]** All code in approved GitHub org (Pin4sf for Waldo). Flag personal repos or non-org imports. |

---

## Severity & Response

| Severity | Criteria | Action |
|---|---|---|
| **CRITICAL** | RCE · data breach · cross-user data access · credential exposure · full auth bypass · CRITICAL CVE | **Block.** Fix immediately. No opt-out. |
| **HIGH** | Endpoint auth bypass · privilege escalation · user-isolation gap · HIGH CVE | **Block.** Fix before merge. No opt-out. |
| **MEDIUM** | Info disclosure via errors · weak config · CORS issues · missing controls | **Flag** with fix. Can be follow-up if a separate ticket is opened. |
| **LOW** | Best-practice gaps · defence-in-depth | **Note** briefly. |

### Review format (MEDIUM+)

```
🔒 SECURITY REVIEW
Issue: [description]
Severity: CRITICAL | HIGH | MEDIUM
Location: [file:line]
Risk: [what an attacker gains — Waldo-specific impact]
Fix: [concrete fix — implement immediately for CRITICAL/HIGH]
```

### Quick format (LOW)

```
⚡ Security note: [risk] → [fix]
```

---

## Handling existing violations

- **In your diff:** fix or flag with the 🔒 format above.
- **Outside your diff:** note briefly. **MUST NOT** refactor without explicit approval — opens a follow-up ticket instead.
- **MUST NEVER** use existing violations to justify new ones.

---

## User-data security (Waldo-specific overlay)

Waldo handles GDPR Art-9 special-category health data. The data plane has stricter rules than typical applications:

- **Health values** (HRV, HR, SpO2, sleep duration, weight, blood pressure, calorie burn, etc.) **MUST NEVER** appear in:
  - `agent_logs`, DO SQLite tables, R2 archive
  - LLM prompts (Scribe sanitiser ADR-0024 enforces 5 checks at runtime)
  - Application logs, OTel spans, Sentry breadcrumbs
  - Trace evaluations, eval fixtures (use synthetic values)
- **Raw health values** live ONLY in Supabase Postgres with RLS `auth.uid() = user_id` on every row.
- **Storage on the device** (waldo-app) **MUST** use SQLCipher for health values — never `AsyncStorage`, never `MMKV`, never plain SQLite.
- **OAuth tokens** for health providers (WHOOP, Oura, Google, Apple) **MUST** be stored in Supabase Vault — never in env vars, never in code, never logged.
- **The service-role key** is used ONLY by `build-intelligence` and audit-write code paths. **MUST NEVER** leave that boundary.

These overlay the universal checklist; they don't replace it.

---

## New API endpoint checklist

Every new endpoint **MUST** have before merging:

- [ ] Authentication (JWT / API key / OAuth / session — service-appropriate)
- [ ] Authorisation (user/role permissions verified; tenant/user scoping if multi-user)
- [ ] Input validation (schema, allowlists, length limits — Zod for TS code)
- [ ] Rate limiting (keyed by user/IP as appropriate; return 429 + `Retry-After`)
- [ ] Error responses that don't leak internals
- [ ] Health-value scrubbing if response could carry physiological data

---

## Security review checklist — universal

**Always:**

- [ ] No secrets in code / config / logs / CI output
- [ ] Client errors don't expose internals
- [ ] Existing security patterns reused (no new auth flows without review)

**Data access:**

- [ ] User scoping enforced from auth context
- [ ] Input validated; parameterised queries only
- [ ] Auth + authz enforced; rate limiting on sensitive endpoints

**Infrastructure:**

- [ ] Containers non-root; minimal capabilities; images pinned
- [ ] RBAC least privilege; secrets managed externally (CF Secrets Store, Supabase Vault)
- [ ] TLS enforced; network exposure minimised

**CI/CD:**

- [ ] Actions pinned to SHAs; minimum permissions; no injection patterns

**Frontend:**

- [ ] No unsafe HTML rendering; tokens not in `AsyncStorage` / `MMKV` / plain SQLite
- [ ] Redirects validated against allowlist; CSP headers configured
- [ ] CSRF protection on state-changing requests (if cookie-based auth)

---

## When to escalate

Reach out to the user (`#bu-security-and-it` Slack channel for Atlan-context work; direct ping for Waldo) **before merging** when changes touch:

- Auth/authz flows or user-isolation logic
- Secrets management or new external integrations
- New public-facing endpoints or services
- Anything where you're unsure about security impact

---

## References

- OWASP Top 10 — https://owasp.org/www-project-top-ten/
- OWASP API Security Top 10 — https://owasp.org/www-project-api-security/
- STRIDE Threat Model — https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats
- GitHub Actions Hardening — https://docs.github.com/en/actions/security-for-github-actions/security-hardening-for-github-actions
- Kubernetes Security — https://kubernetes.io/docs/concepts/security/
- SLSA — https://slsa.dev/
- OpenSSF Scorecard — https://securityscorecards.dev/
