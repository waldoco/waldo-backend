// LOCAL proof: genuine Docker Linux execution, real workspace store and renderer.
// R2, owner directory, channel and Cloudflare container transport remain fixtures.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { workspaceStore, type WorkspaceState, type FileMeta } from '../../packages/workspace/src/store';
import { LinuxContainerExecutor, type LinuxContainer } from '../../packages/runtime/src/execution-environment/linux-container';
import { journaledCompute, type ComputeRecord, type ComputeJournal } from '../../packages/runtime/src/execution-environment/compute-journal';
import { workspaceToolHandlers } from '../../packages/runtime/src/tools/live/workspace';
import { workspaceComputeArgsSchema } from '../../packages/contracts/src/tools/schemas/workspace';

const root = resolve(process.argv[2] ?? '/tmp/waldo-compute-local-journey');
mkdirSync(root, { recursive: true });
const image = 'node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66';
let containerId: string | null = null, executions = 0;
const shell = (args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw Error(r.stderr || 'Docker command failed');
  return r.stdout.trim();
};
const container: LinuxContainer = {
  get running() { return containerId !== null; }, images: { compute: image },
  start(options) {
    assert.equal(options.enableInternet, false);
    containerId = shell(['run', '--detach', '--rm', '--network', 'none', '--memory', '256m', '--cpus', '1', '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--read-only', '--tmpfs', '/workspace:rw,size=16m,uid=1000,gid=1000', '--tmpfs', '/tmp:rw,size=16m,uid=1000,gid=1000', image, ...options.entrypoint]);
  },
  async exec(argv, options) {
    assert.ok(containerId);
    const child = spawn('docker', ['exec', ...(options?.stdin ? ['-i'] : []), ...(options?.cwd ? ['--workdir', options.cwd] : []), containerId, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exitCode = new Promise<number>((done, reject) => { child.on('error', reject); child.on('close', code => done(code ?? -1)); });
    if (options?.stdin) void Readable.fromWeb(options.stdin as never).pipe(child.stdin); else child.stdin.end();
    return { stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>, exitCode };
  },
  async destroy() { if (containerId) { const id = containerId; containerId = null; shell(['rm', '--force', id]); } },
};
const native = new LinuxContainerExecutor(container);
const statePath = resolve(root, 'workspace.json'), journalPath = resolve(root, 'compute.json');
const loadState = (): WorkspaceState => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { binding: null, files: [], bodies: [], operations: [] };
const open = () => workspaceStore({
  binding: { ownerId: '11111111-1111-4111-8111-111111111111', environment: 'local-proof', namespace: 'test', doName: 'synthetic-owner', doId: 'synthetic-owner-do', mappingVersion: 1, stateVersion: 1 },
  admit: async () => ({ status: 'ok' }),
  metadata: { transaction(work) { const state = loadState(), value = work(state); writeFileSync(statePath, JSON.stringify(state)); return value; } },
  bodies: { put: async (body, bytes) => { writeFileSync(resolve(root, body.blob_id), bytes); }, get: async body => existsSync(resolve(root, body.blob_id)) ? new Uint8Array(readFileSync(resolve(root, body.blob_id))) : null, remove: async () => { throw Error('not used'); } },
  now: Date.now, newId: () => crypto.randomUUID(),
});
const journal: ComputeJournal = { transaction(work) {
  const stored = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : null;
  if (stored?.result) stored.result.bytes = new Uint8Array(stored.result.bytes);
  const next = work(stored as ComputeRecord | null);
  writeFileSync(journalPath, JSON.stringify(next.record?.result ? { ...next.record, result: { ...next.record.result, bytes: [...next.record.result.bytes] } } : next.record));
  return next.value;
} };
const executor = () => journaledCompute(journal, async request => { executions++; return native.execute(request); });
let store = await open();
const existing = (await store.list()).files.find(file => file.path === 'orders.csv');
const csv = existing ?? await store.write({ path: 'orders.csv', mime: 'text/csv', bytes: new TextEncoder().encode('item,quantity,unit_price\nNotebook,3,12.50\n"Desk, oak",1,180\nPen,10,1.20\n'), expected_revision: 0, provenance: 'owner_upload', operation_id: crypto.randomUUID() });
const program = `const fs=require('node:fs');
const source=fs.readFileSync('orders.csv','utf8');let rows=[],row=[],cell='',quoted=false;
for(let i=0;i<source.length;i++){const c=source[i];if(c==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\\n'&&!quoted){row.push(cell);rows.push(row);row=[];cell='';}else if(c!=='\\r'||quoted)cell+=c;}
if(cell||row.length){row.push(cell);rows.push(row);}if(quoted)throw Error('Unclosed CSV quote');
const data=rows.slice(1),total=data.reduce((n,r)=>n+Number(r[1])*Number(r[2]),0);
fs.writeFileSync('report.md','# Order report\\n\\nLine items: '+data.length+'\\n\\nTotal: $'+total.toFixed(2)+'\\n\\n'+data.map(r=>'- '+r[0]+': '+r[1]+' units').join('\\n')+'\\n');
console.log(JSON.stringify({platform:process.platform,total,line_items:data.length}));`;
const args = workspaceComputeArgsSchema.parse({ argv: ['node', '-e', program], inputs: [{ file_id: csv.file_id, revision: csv.revision, path: 'orders.csv' }], output_path: 'report.md', path: 'reports/orders.md', mime: 'text/markdown', expected_revision: 0 });
const context = { authenticatedUserId: 'synthetic-owner', turnId: 'local-csv-journey', toolCallId: 'compute-1', assertTaskSourceCurrent: async () => {} };
const handlers = () => workspaceToolHandlers(async () => store, { origin: async () => 'https://waldo.example', durable: true }, undefined, executor);
const compute = handlers().find(h => h.name === 'workspace_compute')!;
const computed = await compute.handle(args as never, context as never);
assert.equal(computed.ok, true, JSON.stringify(computed));
if (!computed.ok) throw Error(computed.error);
const data = computed.data as { file_id: string; revision: number; stdout?: string; delivery: unknown };
const report = await store.export(data.file_id, data.revision);
assert.match(new TextDecoder().decode(report.bytes), /Total: \$229.50/);
if (data.stdout) assert.match(data.stdout, /"platform":"linux"/);
assert.equal(container.running, false);
// Reconstruct host/store and executor to prove continuation from persisted receipts.
store = await open();
const resumed = await handlers().find(h => h.name === 'workspace_compute')!.handle(args as never, context as never);
assert.equal(resumed.ok, true); assert.ok(executions <= 1);
const render = handlers().find(h => h.name === 'workspace_render')!;
const rendered = await render.handle({ source_file_id: data.file_id, source_revision: data.revision, path: 'reports/orders.pdf', expected_revision: 0, format: 'pdf' } as never, { ...context, toolCallId: 'render-1' } as never);
assert.equal(rendered.ok, true, JSON.stringify(rendered));
if (!rendered.ok) throw Error(rendered.error);
const pdfMeta = rendered.data as FileMeta;
const pdf = await store.export(pdfMeta.file_id, pdfMeta.revision);
assert.equal(new TextDecoder().decode(pdf.bytes.slice(0, 5)), '%PDF-');
writeFileSync(resolve(root, 'orders-report.md'), report.bytes); writeFileSync(resolve(root, 'orders-report.pdf'), pdf.bytes);
const evidence = { layer: 'LOCAL_DOCKER', provider_live: false, owner_directory_and_r2: 'fixtures', channel_delivery: 'existing authenticated URL builder; no live channel send', image, compute_receipt: computed, resumed_receipt: resumed, render_receipt: rendered, command_executions_in_this_process: executions, container_cleaned: !container.running, report_text: new TextDecoder().decode(report.bytes) };
// Real Linux adverse cases: no prior files, no host credentials, no network,
// bounded logs/deadline, and teardown of a descendant that outlives its parent.
process.env.WALDO_LOCAL_CREDENTIAL_CANARY = 'must-never-enter-container';
const isolated = await native.execute({ argv: ['node', '-e', `const fs=require('node:fs');if(fs.existsSync('report.md'))throw Error('Prior workspace leaked');if(process.env.WALDO_LOCAL_CREDENTIAL_CANARY)throw Error('Host credential injected');fetch('https://example.com').then(()=>process.exit(2)).catch(()=>fs.writeFileSync('isolation.txt','fresh files; no host credentials; network denied'));`], inputs: [], outputPath: 'isolation.txt', timeoutMs: 5_000, maxOutputBytes: 256 });
assert.equal(isolated.exitCode, 0); assert.match(new TextDecoder().decode(isolated.bytes), /network denied/); assert.equal(container.running, false);
await assert.rejects(native.execute({ argv: ['node', '-e', 'console.log("x".repeat(20000))'], inputs: [], outputPath: 'none', timeoutMs: 5_000, maxOutputBytes: 256 }), /output exceeded limit/);
assert.equal(container.running, false);
await assert.rejects(native.execute({ argv: ['node', '-e', `require('node:child_process').spawn('node',['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)`], inputs: [], outputPath: 'none', timeoutMs: 1_000, maxOutputBytes: 256 }), /deadline/);
assert.equal(container.running, false);
const dashFile = await native.execute({ argv: ['node', '-e', "require('node:fs').writeFileSync('--version','literal output filename')"], inputs: [], outputPath: '--version', timeoutMs: 5_000, maxOutputBytes: 256 });
assert.equal(new TextDecoder().decode(dashFile.bytes), 'literal output filename'); assert.equal(container.running, false);
Object.assign(evidence, { adverse_cases: ['fresh filesystem', 'no automatic host credentials', 'network denied', 'log byte cap', 'deadline with descendant cleanup', 'dash-leading output filename reads actual file'] });
writeFileSync(resolve(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
