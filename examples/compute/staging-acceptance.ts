import type { ComputeService } from '../../packages/runtime/src/channels/compute-host';

export const STAGING_CSV = 'item,quantity,unit_price\nNotebook,3,12.50\n"Desk, oak",1,180\nPen,10,1.20\n';
export const STAGING_REPORT = '# Order report\n\nLine items: 3\n\nTotal: $229.50\n\n- Notebook: 3 units\n- Desk, oak: 1 units\n- Pen: 10 units\n';

// Fixed synthetic probe program. Production compute continues accepting general argv/file inputs.
export const STAGING_PROGRAM = `const fs=require('node:fs'),net=require('node:net'),crypto=require('node:crypto');
const source=fs.readFileSync('orders.csv','utf8');let rows=[],row=[],cell='',quoted=false;
for(let i=0;i<source.length;i++){const c=source[i];if(c==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\\n'&&!quoted){row.push(cell);rows.push(row);row=[];cell='';}else if(c!=='\\r'||quoted)cell+=c;}
if(cell||row.length){row.push(cell);rows.push(row);}if(quoted)throw Error('Unclosed CSV quote');
const data=rows.slice(1),total=data.reduce((n,r)=>n+Number(r[1])*Number(r[2]),0);
if(process.platform!=='linux')throw Error('Not Linux');
if(Object.keys(process.env).some(key=>key!=='PATH'))throw Error('Unexpected process environment');
const socket=net.createConnection({host:'1.1.1.1',port:443});
const timer=setTimeout(()=>{socket.destroy();console.error('Egress test inconclusive');process.exitCode=1;},2000);
socket.once('connect',()=>{clearTimeout(timer);socket.destroy();console.error('Unexpected network access');process.exitCode=1;});
socket.once('error',error=>{clearTimeout(timer);socket.destroy();
if(!['ENETUNREACH','EHOSTUNREACH','ECONNREFUSED','EACCES','EPERM'].includes(error.code)){console.error('Egress test inconclusive');process.exitCode=1;return;}
fs.writeFileSync('report.md','# Order report\\n\\nLine items: '+data.length+'\\n\\nTotal: $'+total.toFixed(2)+'\\n\\n'+data.map(r=>'- '+r[0]+': '+r[1]+' units').join('\\n')+'\\n');
console.log(JSON.stringify({platform:process.platform,network:'denied',environment:'PATH-only',line_items:data.length,total,execution_nonce:crypto.randomUUID()}));});`;

/** Fixed request for the ordinary registered workspace_compute tool, after saving STAGING_CSV. */
export function stagingAcceptanceArgv(): string[] { return ['node', '-e', STAGING_PROGRAM]; }
export function stagingWorkspaceComputeRequest(fileId: string, revision: number, destination = 'compute-staging/report.md') {
  return { argv: stagingAcceptanceArgv(), inputs: [{ file_id: fileId, revision, path: 'orders.csv' }],
    output_path: 'report.md', path: destination, mime: 'text/markdown', expected_revision: 0,
    timeout_ms: 30_000, max_output_bytes: 16_384 };
}

/** Private service-binding helper only. The release operator supplies the existing canonical owner scope. */
export async function stagingProviderAcceptance(service: ComputeService, ownerScope: string, runId: string) {
  if (!ownerScope || ownerScope.length > 512 || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) {
    throw new Error('Invalid staging acceptance identity');
  }
  const operationId = `compute-staging-${runId}`;
  const request = {
    operationId, argv: stagingAcceptanceArgv(),
    inputs: [{ path: 'orders.csv', bytes: new TextEncoder().encode(STAGING_CSV) }],
    outputPath: 'report.md', timeoutMs: 30_000, maxOutputBytes: 16_384,
  };
  // A previously used run ID is rejected instead of disguising receipt recovery as fresh provider proof.
  if (await service.recover(ownerScope, operationId) !== null) throw new Error('Acceptance run ID already used');
  try {
    const result = await service.execute(ownerScope, request);
    if (result.exitCode !== 0 || result.stderr !== '' || new TextDecoder().decode(result.bytes) !== STAGING_REPORT) {
      throw new Error('Provider report acceptance failed');
    }
    let evidence: Record<string, unknown>;
    try { evidence = JSON.parse(result.stdout); } catch { throw new Error('Provider execution evidence missing'); }
    if (evidence.platform !== 'linux' || evidence.network !== 'denied' || evidence.environment !== 'PATH-only' ||
        evidence.line_items !== 3 || evidence.total !== 229.5 ||
        typeof evidence.execution_nonce !== 'string' || evidence.execution_nonce.length !== 36) {
      throw new Error('Provider execution evidence invalid');
    }
    const recovered = await service.recover(ownerScope, operationId);
    const replay = await service.execute(ownerScope, request);
    for (const receipt of [recovered, replay]) {
      if (!receipt || receipt.exitCode !== 0 || receipt.stdout !== result.stdout || receipt.stderr !== '' ||
          new TextDecoder().decode(receipt.bytes) !== STAGING_REPORT) throw new Error('Provider receipt replay mismatch');
    }
    return {
      operationId, artifact: { path: 'report.md', mime: 'text/markdown', bytes: result.bytes },
      receipt: { layer: 'STAGING_PROVIDER', platform: 'linux', network: 'denied', environment: 'PATH-only',
        reportVerified: true, recovered: true, replayedWithoutNewExecution: true,
        executionNonce: evidence.execution_nonce, maxStartedInstances: 1, timeoutMs: 30_000 },
    };
  } finally {
    // The native adapter already destroys on every path; explicit cancel is additional harness cleanup.
    await service.cancel(ownerScope, operationId);
  }
}
