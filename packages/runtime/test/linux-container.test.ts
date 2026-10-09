import { describe, expect, it } from 'vitest';
import {
  LinuxContainerExecutor, type LinuxContainer, type LinuxContainerProcess, type LinuxComputeRequest,
} from '../src/execution-environment/linux-container';

function process(stdout = '', stderr = '', exitCode = 0): LinuxContainerProcess {
  const pipe = (value: string) => new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(value)); controller.close();
  } });
  return { stdout: pipe(stdout), stderr: pipe(stderr), exitCode: Promise.resolve(exitCode) };
}

class ContainerFixture implements LinuxContainer {
  running = false;
  images = { compute: `docker.io/library/node@sha256:${'a'.repeat(64)}` };
  starts: Parameters<LinuxContainer['start']>[0][] = [];
  commands: string[][] = [];
  destroys = 0;
  responses = [process(), process('generated report\n'), process('category,total\na,12\n')];
  transfer = '';

  start(options: Parameters<LinuxContainer['start']>[0]) { this.starts.push(options); this.running = true; }
  async exec(argv: string[], options?: Parameters<LinuxContainer['exec']>[1]) {
    this.commands.push(argv);
    if (options?.stdin) this.transfer = await new Response(options.stdin).text();
    return this.responses.shift() ?? process();
  }
  async destroy() { this.destroys++; this.running = false; }
}

const request = (): LinuxComputeRequest => ({
  argv: ['node', 'transform.js'], inputs: [{ path: 'owner.csv', bytes: new TextEncoder().encode('a,12\n') }],
  outputPath: 'report.csv', timeoutMs: 1000, maxOutputBytes: 256 * 1024,
});

describe('native Linux container boundary', () => {
  it('transfers owner bytes separately from argv and destroys the instance after artifact readback', async () => {
    const container = new ContainerFixture();
    const result = await new LinuxContainerExecutor(container).execute(request());
    expect(new TextDecoder().decode(result.bytes)).toBe('category,total\na,12\n');
    expect(container.starts[0]?.enableInternet).toBe(false);
    expect(container.starts[0]?.instance).toBe('lite');
    expect(container.starts[0]?.entrypoint).toEqual(['sleep', '35']);
    expect(container.commands[1]).toEqual(['node', 'transform.js']);
    expect(JSON.parse(container.transfer)).toEqual([{ path: 'owner.csv', data: btoa('a,12\n') }]);
    expect(container.commands[2]?.slice(-2)).toEqual(['report.csv', '262144']);
    expect(container.destroys).toBe(1);
    expect(container.running).toBe(false);
  });

  it('rejects traversal and aggregate input limits before starting any provider operation', async () => {
    for (const bad of [
      { ...request(), outputPath: '../other-owner/file' },
      { ...request(), inputs: [{ path: 'large.csv', bytes: new Uint8Array(262145) }] },
      { ...request(), timeoutMs: 30001 },
    ]) {
      const container = new ContainerFixture();
      await expect(new LinuxContainerExecutor(container).execute(bad)).rejects.toThrow();
      expect(container.starts).toHaveLength(0);
      expect(container.destroys).toBe(0);
    }
  });

  it('keeps a dash-leading output filename out of Node option parsing', async () => {
    const container = new ContainerFixture();
    await new LinuxContainerExecutor(container).execute({ ...request(), outputPath: '--version' });
    expect(container.commands[2]?.slice(-3)).toEqual(['--', '--version', '262144']);
    expect(container.destroys).toBe(1);
  });

  it('rejects unpinned images before starting a provider operation', async () => {
    const container = new ContainerFixture(); container.images.compute = 'node:latest';
    await expect(new LinuxContainerExecutor(container).execute(request())).rejects.toThrow('digest pinned');
    expect(container.starts).toHaveLength(0);
  });

  it('caps both log pipes together and destroys descendants through the whole container boundary', async () => {
    const container = new ContainerFixture();
    container.responses = [process(), process('x'.repeat(9000), 'y'.repeat(9000))];
    await expect(new LinuxContainerExecutor(container).execute(request())).rejects.toThrow('output exceeded');
    expect(container.destroys).toBe(1);
    expect(container.commands).toHaveLength(2);
  });

  it('does not deliver an oversized artifact or retain its process', async () => {
    const container = new ContainerFixture();
    await expect(new LinuxContainerExecutor(container).execute({ ...request(), maxOutputBytes: 4 }))
      .rejects.toThrow('output transfer failed');
    expect(container.destroys).toBe(1);
  });

  it('cleans up a failed command without attempting artifact readback', async () => {
    const container = new ContainerFixture(); container.responses = [process(), process('', 'bad csv', 2)];
    const result = await new LinuxContainerExecutor(container).execute(request());
    expect(result.exitCode).toBe(2); expect(result.bytes.byteLength).toBe(0);
    expect(container.commands).toHaveLength(2); expect(container.destroys).toBe(1);
  });

  it('never starts a new VM when cancellation arrives during preexisting VM cleanup', async () => {
    const container = new ContainerFixture(); container.running = true;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    container.destroy = async () => { container.destroys++; await gate; container.running = false; };
    const controller = new AbortController();
    const execution = new LinuxContainerExecutor(container).execute({ ...request(), signal: controller.signal });
    controller.abort(); release();
    await expect(execution).rejects.toThrow('cancelled');
    await Promise.resolve();
    expect(container.starts).toHaveLength(0);
  });

  it('destroys a VM with a stalled exec at the operation deadline', async () => {
    const container = new ContainerFixture();
    container.exec = async () => new Promise<LinuxContainerProcess>(() => {});
    await expect(new LinuxContainerExecutor(container).execute({ ...request(), timeoutMs: 1 }))
      .rejects.toThrow('deadline exceeded');
    expect(container.destroys).toBe(1); expect(container.running).toBe(false);
  });
});
