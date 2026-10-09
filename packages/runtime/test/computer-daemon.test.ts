import { env, runInDurableObject } from 'cloudflare:test';
import { TestBackend, Workspace } from '@cloudflare/computer';
import { expect, it } from 'vitest';
import { ComputerContainerExecutor } from '../src/execution-environment/computer-container';

const CSV = 'item,quantity,unit_price\nNotebook,3,12.50\n"Desk, oak",1,180\nPen,10,1.20\n';
const REPORT = '# Order report\n\nLine items: 3\n\nTotal: $229.50\n';
const PROGRAM = `const fs=require('node:fs');
const lines=fs.readFileSync('orders.csv','utf8').trimEnd().split('\\n').slice(1);
const rows=lines.map(line=>{const cells=[];let cell='',quoted=false;for(const c of line){if(c==='"')quoted=!quoted;else if(c===','&&!quoted){cells.push(cell);cell='';}else cell+=c;}cells.push(cell);return cells;});
const total=rows.reduce((sum,row)=>sum+Number(row[1])*Number(row[2]),0);
fs.writeFileSync('report.md','# Order report\\n\\nLine items: '+rows.length+'\\n\\nTotal: $'+total.toFixed(2)+'\\n');
console.log(process.platform);`;

it('actual Docker computerd executes CSV to report through released Computer and persists its pulled file in workerd SQLite', async () => {
  const bindings = env as unknown as {
    COMPUTERD_HARNESS_URL: string;
    COMPUTER_DAEMON_STORAGE: DurableObjectNamespace;
  };
  if (!bindings.COMPUTERD_HARNESS_URL) throw Error('Actual daemon URL missing; fixture may not skip.');
  const stub = bindings.COMPUTER_DAEMON_STORAGE.get(bindings.COMPUTER_DAEMON_STORAGE.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    let workspace: Workspace | undefined;
    let destroyed = 0;
    const executor = new ComputerContainerExecutor({
      async open(checkCurrent) {
        checkCurrent();
        workspace = new Workspace({ storage: state.storage,
          backends: [new TestBackend({ id: 'container', url: bindings.COMPUTERD_HARNESS_URL })] });
        await workspace.ready();
        checkCurrent();
        return workspace;
      },
      // Docker lifecycle remains with the shell operator. Native destruction is a fixture here.
      async destroy() { destroyed++; },
    });
    const result = await executor.execute({ argv: ['node', '-e', PROGRAM],
      inputs: [{path:'orders.csv',bytes:new TextEncoder().encode(CSV)}], outputPath:'report.md',
      timeoutMs:30_000, maxOutputBytes:16_384 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('linux');
    expect(result.stderr).toBe('');
    expect(new TextDecoder().decode(result.bytes)).toBe(REPORT);
    expect(destroyed).toBe(1);
    // Reopen the real SQLite file store, without launching or rerunning a command.
    const reopened = new Workspace({ storage: state.storage });
    try {
      expect(await reopened.fs.readFile('/workspace/report.md', 'utf8')).toBe(REPORT);
      expect(await reopened.fs.stat('/workspace/report.md')).toMatchObject({isFile:true,size:new TextEncoder().encode(REPORT).length});
    } finally { await reopened.close(); }
  });
});
