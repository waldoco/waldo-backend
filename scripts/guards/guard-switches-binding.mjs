#!/usr/bin/env node

// Cloudflare caps a Worker's variables at 128, secrets and text vars together, and a deploy past it fails at upload
// ("Too many text bindings", code 10055). Feature switches and tuning knobs therefore live in one JSON var,
// WALDO_SWITCHES, which packages/runtime/src/switches.ts flattens into env at every entry seam. This guard keeps that
// true:
// 1. Only the vars listed below stay flat; anything new goes in WALDO_SWITCHES.
// 2. WALDO_SWITCHES holds string values only, shares no name with a flat var, and stays under Cloudflare's 5 KB
//    per-variable cap.
// 3. Flat vars plus the secrets the production runbook names stay at or under BINDING_BUDGET in every environment.
// 4. Nothing below a seam reads an env that skipped it: every Durable Object or entrypoint class passes
//    withSwitches(env) to super, the Worker's default export flattens in each handler, and no module imports env
//    from cloudflare:workers or reads process.env.

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../jsonc.mjs';

export const DISPOSITION = 'block';
const NAME = 'guard-switches-binding';

// Cloudflare's cap is 128 (Paid). Ten are kept free for secrets set without a runbook row and for a deploy's --var.
export const BINDING_BUDGET = 118;
// Cloudflare's per-variable cap is 5 KB; the page does not say whether that is 1000 or 1024 bytes, or what it measures.
export const SWITCHES_MAX_BYTES = 4500;

// Each flat var, and why it is not in WALDO_SWITCHES.
export const FLAT_VARS = new Map([
  ['WALDO_SWITCHES', 'the switches themselves'],
  ['WALDO_ENVIRONMENT', 'trace identity; deploy, preview and dry-run scripts read it by name'],
  ['WALDO_PUBLIC_ORIGIN', 'origin; the staging gate and probe read it by name'],
  ['WALDO_OWNER_DO_NAMESPACE', 'identity; the dry run and preview guards read it by name'],
  ['WALDO_RELEASE', 'deploy label; the deploy wrapper restamps it with --var at upload'],
  ['WALDO_OWNER_TELEGRAM_ID', 'owner routing; the preview guards and wiring scripts read it by name'],
  ['WALDO_MODEL_PROVIDER', 'provider config'],
  ['WALDO_MCP_SERVERS', 'provider config'],
  ['GMAIL_PUSH_PROJECT', 'provider config'],
  ['LANGFUSE_CAPTURE_TEXT', 'privacy control; the dry run and preview guards read it by name'],
  ['WALDO_EGRESS_ALLOWLIST', 'security control; the dry run and preview guards read it by name'],
  ['WHATSAPP_DEBUG_LOG', 'privacy control; the dry run reads it by name'],
  ['IMESSAGE_CONNECTOR_POLICY', 'provider config'],
  ['IMESSAGE_ONBOARDING_URL', 'provider config'],
  ['IMESSAGE_WALDO_ADDRESS', 'provider config'],
  ['PHOTON_PROJECT_ID', 'provider config'],
  ['WHATSAPP_REENGAGE_TEMPLATE', 'provider config'],
  ['WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE', 'provider config'],
  ['WHATSAPP_PROACTIVE_TEMPLATE', 'provider config'],
  ['WHATSAPP_PROACTIVE_TEMPLATE_LANGUAGE', 'provider config'],
  ['WHATSAPP_ONBOARDING_URL', 'provider config'],
  ['WHATSAPP_WALDO_NUMBER', 'provider config'],
  ['AGENT_MAIL_DOMAIN', 'provider config'],
  ['AGENT_MAIL_ZONE_ID', 'provider config'],
]);

// The secret names in the runbook's "Worker secrets" table (first column). An upper bound on what is deployed: at
// 1808c6ed the table named 40 against 32 deployed secrets.
export const runbookSecretNames = (runbook) => {
  const section = runbook.split(/^### 1\.3 /m)[1]?.split(/^### /m)[0] ?? '';
  const names = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    for (const match of line.split('|')[1].matchAll(/`([A-Z][A-Z0-9_]*)`/g)) names.add(match[1]);
  }
  return [...names];
};

export const checkConfig = (cfg, secretNames) => {
  const bad = [], counts = [];
  if (secretNames.length === 0) bad.push('no secret names found in the runbook\'s section 1.3 table, so the binding count cannot be checked');
  const blocks = [['production', cfg?.vars, true], ...Object.entries(cfg?.env ?? {}).map(([name, block]) => [name, block?.vars, true]), ['previews', cfg?.previews?.vars, false]];
  for (const [label, vars, deploysSecrets] of blocks) {
    if (!vars) continue;
    const flat = Object.keys(vars);
    for (const name of flat) if (!FLAT_VARS.has(name)) bad.push(`${label}: var "${name}" must go in WALDO_SWITCHES, or be added to FLAT_VARS with its reason`);
    const switches = vars.WALDO_SWITCHES;
    if (deploysSecrets && (!switches || typeof switches !== 'object' || Array.isArray(switches))) bad.push(`${label}: WALDO_SWITCHES must be an object of switches`);
    if (switches && typeof switches === 'object') {
      for (const [name, value] of Object.entries(switches)) {
        if (typeof value !== 'string') bad.push(`${label}: WALDO_SWITCHES.${name} must be a string`);
        if (name in vars) bad.push(`${label}: "${name}" is declared both flat and in WALDO_SWITCHES`);
      }
      const bytes = new TextEncoder().encode(JSON.stringify(switches)).length;
      if (bytes > SWITCHES_MAX_BYTES) bad.push(`${label}: WALDO_SWITCHES is ${bytes} bytes, over ${SWITCHES_MAX_BYTES}`);
    }
    const total = flat.length + (deploysSecrets ? secretNames.length : 0);
    counts.push(`${label} ${total}`);
    if (total > BINDING_BUDGET) bad.push(`${label}: ${flat.length} vars + ${secretNames.length} secrets = ${total} bindings, over ${BINDING_BUDGET}`);
  }
  return { bad, counts };
};

const requireRuntimeDependency = createRequire(new URL('../../packages/runtime/package.json', import.meta.url));

// Classes whose constructor need not flatten: the retired declarations read nothing, and the lazy forwarder hands its
// raw env to the real class, which flattens.
const EXEMPT_CLASSES = new Set(['src/retired-durable-objects.ts:RuntimeProbeDO', 'src/retired-durable-objects.ts:RunLoopDO',
  'src/retired-durable-objects.ts:TracerDO', 'src/lazy-entry.ts:Forwarder']);

export const checkSources = (files) => {
  const ts = requireRuntimeDependency('typescript');
  const bad = [];
  const isFlattenCall = (node) => node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withSwitches';
  for (const { path, text } of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'cloudflare:workers') {
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamedImports(named) && named.elements.some((element) => (element.propertyName ?? element.name).text === 'env')) {
          bad.push(`${path}: imports env from cloudflare:workers, which skips the switch seam`);
        }
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process' && node.name.text === 'env' && !path.startsWith('src/cli/')) {
        bad.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: reads process.env, which skips the switch seam`);
      }
      if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.heritageClauses) {
        const base = node.heritageClauses.flatMap((clause) => clause.types).map((type) => type.expression.getText(source))[0] ?? '';
        const name = node.name?.text ?? '(anonymous)';
        if ((base === 'DurableObject' || /Entrypoint$/.test(base)) && !EXEMPT_CLASSES.has(`${path}:${name}`)) {
          const ctor = node.members.find((member) => ts.isConstructorDeclaration(member));
          const superCall = ctor?.body?.statements.map((statement) => ts.isExpressionStatement(statement) ? statement.expression : undefined)
            .find((expression) => expression && ts.isCallExpression(expression) && expression.expression.kind === ts.SyntaxKind.SuperKeyword);
          if (!isFlattenCall(superCall?.arguments[1])) bad.push(`${path}: class ${name} must call super(ctx, withSwitches(env)) in its constructor`);
        }
      }
      if (path === 'src/index.ts' && ts.isExportAssignment(node) && !node.isExportEquals) {
        let handler = node.expression;
        while (ts.isSatisfiesExpression(handler) || ts.isAsExpression(handler) || ts.isParenthesizedExpression(handler)) handler = handler.expression;
        if (!ts.isObjectLiteralExpression(handler)) bad.push('src/index.ts: the default export must be an object literal of handlers');
        else for (const property of handler.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) { bad.push(`src/index.ts: default export entry "${property.getText(source).slice(0, 40)}" must be a handler that flattens env`); continue; }
          let flattens = false;
          const find = (inner) => { if (isFlattenCall(inner)) flattens = true; else ts.forEachChild(inner, find); };
          find(property);
          if (!flattens) bad.push(`src/index.ts: default export handler ${property.name.getText(source)} must pass withSwitches(env)`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return bad;
};

const sourceFiles = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push({ path: relative(join(root, 'packages/runtime'), full), text: readFileSync(full, 'utf8') });
    }
  };
  walk(join(root, 'packages/runtime/src'));
  return out;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const cfg = parseJsonc(readFileSync(join(root, 'packages/runtime/wrangler.jsonc'), 'utf8'));
  const secrets = runbookSecretNames(readFileSync(join(root, 'docs/ops/PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md'), 'utf8'));
  const { bad, counts } = checkConfig(cfg, secrets);
  bad.push(...checkSources(sourceFiles(root)));
  if (bad.length) {
    process.stderr.write(`${NAME}: ${bad.join('; ')}\n`);
    process.exit(1);
  }
  const switches = Object.keys(cfg.vars?.WALDO_SWITCHES ?? {}).length;
  console.log(`${NAME}: ok (bindings, flat vars plus ${secrets.length} runbook secrets: ${counts.join(', ')}; budget ${BINDING_BUDGET}; WALDO_SWITCHES ${switches} names)`);
}
