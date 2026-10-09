import type { Workspace } from '@cloudflare/computer';
import { validatePath } from '@waldo/workspace';
import type { LinuxComputeRequest, LinuxComputeResult } from './linux-container';

export type ComputerWorkingCopy = Pick<Workspace, 'fs' | 'runtime' | 'pull' | 'close'>;
export type ComputerComputeHost = Readonly<{
  open(checkCurrent: () => void): Promise<ComputerWorkingCopy>;
  destroy(reason: string): Promise<void>;
}>;
const FILE_BYTES = 262_144;
const LOG_BYTES = 16_384;
const quote = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;

/** Nondefault Computer 0.5 trial. Workspace is a task copy, never the owner file authority. */
export class ComputerContainerExecutor {
  private busy = false;
  constructor(private readonly host: ComputerComputeHost) {}

  async execute(request: LinuxComputeRequest): Promise<LinuxComputeResult> {
    if (this.busy) throw Error('Compute instance already has an active operation');
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30_000 ||
      !Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > FILE_BYTES ||
      !request.argv.length || request.argv.length > 64 || request.argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 32_768) || request.inputs.length > 32) throw Error('Compute request exceeds supported bounds');
    validatePath(request.outputPath);
    const paths = new Set<string>(); let inputBytes = 0;
    for (const input of request.inputs) {
      validatePath(input.path);
      if (!(input.bytes instanceof Uint8Array) || paths.has(input.path) || input.path === request.outputPath) throw Error('Invalid compute input');
      paths.add(input.path); inputBytes += input.bytes.byteLength;
    }
    if (inputBytes > FILE_BYTES || request.signal?.aborted) throw Error('Compute inputs exceeded limit or cancelled');
    this.busy = true;
    let interrupted = false, workspace: ComputerWorkingCopy | undefined;
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (reason: string) => { interrupted = true; rejectStop(Error(reason)); };
    const check = () => { if (interrupted || request.signal?.aborted) throw Error('Compute interrupted'); };
    const abort = () => stop('Compute cancelled');
    request.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Compute deadline exceeded'), request.timeoutMs);
    try {
      const run = async (): Promise<LinuxComputeResult> => {
        check();
        workspace = await this.host.open(check); check();
        await workspace.fs.mkdir('/workspace', { recursive: true }); check();
        for (const input of request.inputs) {
          const path = `/workspace/${input.path}`;
          await workspace.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true }); check();
          await workspace.fs.writeFile(path, input.bytes); check();
        }
        // output:false avoids saved overflow files. Stream and result() are exclusive in 0.5.
        const handle = await workspace.runtime.exec(request.argv.map(quote).join(' '), {
          backend: 'container', cwd: '/workspace', env: {}, timeoutMs: request.timeoutMs, sync: 'wait', output: false, encoding: 'utf8',
        }); check();
        let size = 0, exitCode: number | undefined;
        const stdout: Uint8Array[] = [], stderr: Uint8Array[] = [];
        const reader = handle.getReader();
        try {
          while (true) {
            const next = await reader.read(); check();
            if (next.done) break;
            const event = next.value;
            if (event.name === 'exit') {
              if (exitCode !== undefined || !Number.isSafeInteger(event.code)) throw Error('Invalid compute exit receipt');
              exitCode = event.code;
            } else {
              if (typeof event.value !== 'string') throw Error('Invalid compute output chunk');
              const chunk = new TextEncoder().encode(event.value);
              size += chunk.byteLength;
              if (size > LOG_BYTES) throw Error('Compute logs exceeded limit');
              (event.name === 'stdout' ? stdout : stderr).push(chunk);
            }
          }
        } finally { reader.releaseLock(); }
        if (exitCode === undefined) throw Error('Compute exit receipt unavailable');
        const text = (chunks: Uint8Array[]) => {
          const length = chunks.reduce((n, chunk) => n + chunk.byteLength, 0), bytes = new Uint8Array(length);
          let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return new TextDecoder().decode(bytes);
        };
        const diagnostics = { stdout: text(stdout), stderr: text(stderr), exitCode };
        if (exitCode !== 0) return { ...diagnostics, bytes: new Uint8Array() };
        // Stream EOF may conceal post-command sync failure. Require an explicit complete pull.
        let complete = false;
        for await (const progress of workspace.pull('container')) {
          check();
          if (progress.skipped !== 0) throw Error('Compute sync skipped files');
          complete = progress.complete;
        }
        if (!complete) throw Error('Compute sync is incomplete');
        const output = `/workspace/${request.outputPath}`;
        let path = '';
        for (const part of output.split('/').filter(Boolean)) {
          path += `/${part}`;
          const stat = await workspace.fs.lstat(path); check();
          if (stat.isSymbolicLink || (path !== output && !stat.isDirectory)) throw Error('Compute output traverses a symlink or non-directory');
          if (path === output && (!stat.isFile || stat.size > request.maxOutputBytes)) throw Error('Compute output is not a bounded regular file');
        }
        const stream = await workspace.fs.readFile(output, { byteLength: request.maxOutputBytes + 1 }); check();
        const fileReader = stream.getReader(); const chunks: Uint8Array[] = []; let bytesRead = 0;
        try {
          while (true) {
            const next = await fileReader.read(); check();
            if (next.done) break;
            bytesRead += next.value.byteLength;
            if (bytesRead > request.maxOutputBytes) throw Error('Compute output exceeded limit');
            chunks.push(next.value.slice());
          }
        } finally { fileReader.releaseLock(); }
        const bytes = new Uint8Array(bytesRead); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return { ...diagnostics, bytes };
      };
      return await Promise.race([run(), stopped]);
    } finally {
      clearTimeout(timer); interrupted = true;
      request.signal?.removeEventListener('abort', abort);
      // Workspace.close is not VM destruction; descendants and late starts need native teardown.
      try { await this.host.destroy('Computer compute finished'); }
      finally { try { await workspace?.close(); } finally { this.busy = false; } }
    }
  }
}
