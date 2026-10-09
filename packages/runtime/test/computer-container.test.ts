// Adapter contract proof with labelled Computer/transport doubles, not actual daemon proof.
import { describe, expect, it, vi } from 'vitest';
import { ComputerContainerExecutor, type ComputerWorkingCopy } from '../src/execution-environment/computer-container';
import type { LinuxComputeRequest } from '../src/execution-environment/linux-container';
const bytes = (s: string) => new TextEncoder().encode(s);
const request = (): LinuxComputeRequest => ({ argv: ['node', '-e', "console.log('CSV')"], inputs: [{ path: 'input.csv', bytes: bytes('amount\n5\n') }], outputPath: 'report.md', timeoutMs: 1000, maxOutputBytes: 100 });
const fixture = () => {
  const files = new Map<string, Uint8Array>([['/workspace/report.md', bytes('# Total: 5')]]);
  let events: any[] = [{ name: 'stdout', value: 'processed' }, { name: 'exit', code: 0 }];
  let progress = [{ complete: true, skipped: 0 }];
  const result = vi.fn(() => { throw Error('stream and result are exclusive'); });
  const exec = vi.fn(async () => Object.assign(new ReadableStream({ start(c) { for (const event of events) c.enqueue(event); c.close(); } }), { result }));
  const readFile = vi.fn(async (path: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(files.get(path)!); c.close(); } }));
  const lstat = vi.fn(async (path: string) => ({ isFile: files.has(path), isDirectory: !files.has(path), isSymbolicLink: false, size: files.get(path)?.length ?? 0 }));
  const pull = vi.fn(async function* () { for (const p of progress) yield p; });
  const copy = { fs: { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async (path: string, value: Uint8Array) => { files.set(path,value.slice()); }), lstat, readFile }, runtime: { exec }, pull, close: vi.fn(async () => {}) } as unknown as ComputerWorkingCopy;
  const host = { open: vi.fn(async (check: () => void) => { check(); return copy; }), destroy: vi.fn(async () => {}) };
  return { executor: new ComputerContainerExecutor(host), host, copy, files, exec, result, readFile, lstat, pull, events: (next: any[]) => { events=next; }, progress: (next: typeof progress) => { progress=next; } };
};
describe('Computer compute trial adapter', () => {
  it('maps only selected files, quotes argv, drains sync and exports declared output before VM cleanup', async () => {
    const f=fixture(); expect(await f.executor.execute(request())).toEqual({ bytes: bytes('# Total: 5'), stdout:'processed',stderr:'',exitCode:0 });
    expect(f.copy.fs.writeFile).toHaveBeenCalledWith('/workspace/input.csv',bytes('amount\n5\n'));
    expect(f.exec.mock.calls[0]).toEqual([String.raw`'node' '-e' 'console.log('\''CSV'\'')'`, {backend:'container',cwd:'/workspace',env:{},timeoutMs:1000,sync:'wait',output:false,encoding:'utf8'}]);
    expect(f.result).not.toHaveBeenCalled(); expect(f.pull).toHaveBeenCalledWith('container');
    expect(f.readFile).toHaveBeenCalledWith('/workspace/report.md',{byteLength:101}); expect(f.host.destroy).toHaveBeenCalledTimes(1);
  });
  it('returns nonzero diagnostics without sync/export and destroys the entire VM', async () => {
    const f=fixture(); f.events([{name:'stderr',value:'bad CSV'},{name:'exit',code:2}]);
    expect(await f.executor.execute(request())).toEqual({bytes:new Uint8Array(),stdout:'',stderr:'bad CSV',exitCode:2});
    expect(f.readFile).not.toHaveBeenCalled(); expect(f.host.destroy).toHaveBeenCalledTimes(1);
  });
  it.each([{progress:[{complete:false,skipped:0}]},{progress:[{complete:true,skipped:1}]},{progress:[]}])('refuses incomplete or skipped sync %j', async ({progress}) => {
    const f=fixture(); f.progress(progress); await expect(f.executor.execute(request())).rejects.toThrow('sync');
    expect(f.readFile).not.toHaveBeenCalled(); expect(f.host.destroy).toHaveBeenCalledTimes(1);
  });
  it('continues after exit to EOF and enforces combined log bytes', async () => {
    const f=fixture(); f.events([{name:'stdout',value:'a'.repeat(9000)},{name:'exit',code:0},{name:'stderr',value:'b'.repeat(9000)}]);
    await expect(f.executor.execute(request())).rejects.toThrow('logs exceeded'); expect(f.readFile).not.toHaveBeenCalled(); expect(f.host.destroy).toHaveBeenCalledTimes(1);
  });
  it('rejects symlink ancestors before reading output', async () => {
    const f=fixture(); f.lstat.mockResolvedValue({isFile:false,isDirectory:true,isSymbolicLink:true,size:0});
    await expect(f.executor.execute(request())).rejects.toThrow('symlink'); expect(f.readFile).not.toHaveBeenCalled();
  });
  it('rejects a growing stream even when stat was within limit', async () => {
    const f=fixture(); f.files.set('/workspace/report.md',new Uint8Array(101)); f.lstat.mockResolvedValue({isFile:true,isDirectory:true,isSymbolicLink:false,size:10});
    await expect(f.executor.execute(request())).rejects.toThrow('output exceeded'); expect(f.host.destroy).toHaveBeenCalledTimes(1);
  });
  it('fences a late asynchronous open after cancellation', async () => {
    const f=fixture(); let release!:()=>void; const gate=new Promise<void>(r=>{release=r;});
    f.host.open.mockImplementation(async check=>{await gate;check();return f.copy;});
    const controller=new AbortController(); const running=f.executor.execute({...request(),signal:controller.signal}); controller.abort();
    await expect(running).rejects.toThrow('cancelled'); release(); await Promise.resolve();
    expect(f.exec).not.toHaveBeenCalled(); expect(f.host.destroy).toHaveBeenCalledTimes(1);
  });
  it('refuses invalid paths before opening the environment', async () => {
    const f=fixture(); await expect(f.executor.execute({...request(),outputPath:'../escape'})).rejects.toThrow(); expect(f.host.open).not.toHaveBeenCalled();
  });
});
