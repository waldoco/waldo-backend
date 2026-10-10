/** Native Cloudflare Container boundary. The host selects one exclusive owner instance. */
export interface LinuxContainerProcess {
  readonly stdout?: ReadableStream<Uint8Array> | null;
  readonly stderr?: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
}

export interface LinuxContainer {
  readonly running: boolean;
  readonly images: Readonly<Record<string, string>>;
  start(options: { image: string; instance: 'lite'; entrypoint: string[]; enableInternet: false }): void;
  exec(argv: string[], options?: {
    stdin?: ReadableStream<Uint8Array>;
    cwd?: string;
    env?: Record<string, string>;
    stdout?: 'pipe';
    stderr?: 'pipe';
  }): Promise<LinuxContainerProcess>;
  destroy(reason?: string): Promise<void>;
}

export type LinuxComputeRequest = Readonly<{
  argv: readonly string[];
  inputs: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  outputPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}>;

export type LinuxComputeResult = Readonly<{
  bytes: Uint8Array;
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

const FILE_LIMIT = 256 * 1024;
const LOG_LIMIT = 16 * 1024;

// Fixed helper source: caller filenames and bytes arrive as JSON stdin, never shell source.
const WRITE_INPUTS = `const fs=require('node:fs');const path=require('node:path');
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>text+=x);
process.stdin.on('end',()=>{const input=JSON.parse(text);fs.mkdirSync('/workspace',{recursive:true});
for(const file of input){const p=path.join('/workspace',file.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(file.data,'base64'));}});`;

const READ_OUTPUT = `const fs=require('node:fs');const path=require('node:path');
const p=path.join('/workspace',process.argv[1]);const limit=Number(process.argv[2]);
const resolved=fs.realpathSync(p);if(!resolved.startsWith('/workspace/'))throw Error('Output outside workspace');
const fd=fs.openSync(resolved,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>limit)throw Error('Output is not a bounded regular file');
const bytes=Buffer.alloc(limit+1);let size=0;while(size<bytes.length){const n=fs.readSync(fd,bytes,size,bytes.length-size,null);if(!n)break;size+=n;}
if(size>limit)throw Error('Output exceeded limit');process.stdout.write(bytes.subarray(0,size));}finally{fs.closeSync(fd);}`;

function validatePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512 ||
      path.includes('\\') || path.includes('\0') ||
      path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Compute file path must be relative to the workspace');
  }
}

function base64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

async function capture(process: LinuxContainerProcess, limit: number): Promise<{
  stdout: Uint8Array; stderr: Uint8Array; exitCode: number;
}> {
  let size = 0;
  async function read(stream?: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
    if (!stream) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new Error('Compute output exceeded limit');
        chunks.push(next.value);
        length += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }
  // Both pipes must drain concurrently; otherwise one full pipe can deadlock the process.
  const [stdout, stderr, exitCode] = await Promise.all([
    read(process.stdout), read(process.stderr), process.exitCode,
  ]);
  return { stdout, stderr, exitCode };
}

/** Rehydrate workspace inputs per call; interruption never relies on surviving Linux processes. */
export class LinuxContainerExecutor {
  private busy = false;

  constructor(private readonly container: LinuxContainer, private readonly imageKey = 'compute') {}

  async execute(request: LinuxComputeRequest): Promise<LinuxComputeResult> {
    if (this.busy) throw new Error('Compute instance already has an active operation');
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30_000 ||
        !Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > FILE_LIMIT ||
        request.argv.length === 0 || request.argv.length > 64 ||
        request.argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 32_768) ||
        request.inputs.length > 32) throw new Error('Compute request exceeds supported bounds');
    validatePath(request.outputPath);
    let inputSize = 0;
    const paths = new Set<string>();
    for (const input of request.inputs) {
      validatePath(input.path);
      if (!(input.bytes instanceof Uint8Array) || paths.has(input.path)) throw new Error('Invalid compute input');
      paths.add(input.path);
      inputSize += input.bytes.byteLength;
    }
    if (inputSize > FILE_LIMIT) throw new Error('Compute inputs exceeded limit');
    if (request.signal?.aborted) throw new Error('Compute cancelled');
    const image = this.container.images[this.imageKey];
    // Wrangler resolves configured official images to digest-pinned references.
    if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Compute image must be digest pinned');
    this.busy = true;
    let interrupted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop: (reason: Error) => void = () => {};
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (reason: string) => { interrupted = true; rejectStop(new Error(reason)); };
    const check = () => { if (interrupted) throw new Error('Compute interrupted'); };
    const abort = () => stop('Compute cancelled');
    request.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('Compute deadline exceeded'), request.timeoutMs);
    try {
      const run = async (): Promise<LinuxComputeResult> => {
        // No preexisting filesystem/process/network policy is inherited by a new operation.
        if (this.container.running) await this.container.destroy('Fresh compute operation');
        check();
        // The finite PID1 also stops ordinary abandoned work after a DO crash.
        this.container.start({ image, instance: 'lite', entrypoint: ['sleep', '35'], enableInternet: false });
        const inputText = JSON.stringify(request.inputs.map(file => ({ path: file.path, data: base64(file.bytes) })));
        const stdin = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(inputText)); controller.close();
        } });
        const write = await capture(await this.container.exec(['node', '-e', WRITE_INPUTS], { stdin }), LOG_LIMIT);
        check();
        if (write.exitCode !== 0) throw new Error('Compute input transfer failed');
        const command = await capture(await this.container.exec([...request.argv], {
          cwd: '/workspace', env: {}, stdout: 'pipe', stderr: 'pipe',
        }), LOG_LIMIT);
        check();
        if (command.exitCode !== 0) return {
          bytes: new Uint8Array(), stdout: new TextDecoder().decode(command.stdout),
          stderr: new TextDecoder().decode(command.stderr), exitCode: command.exitCode,
        };
        const output = await capture(await this.container.exec([
          'node', '-e', READ_OUTPUT, '--', request.outputPath, String(request.maxOutputBytes),
        ], { stdout: 'pipe', stderr: 'pipe' }), request.maxOutputBytes + LOG_LIMIT);
        check();
        if (output.exitCode !== 0 || output.stdout.byteLength > request.maxOutputBytes) {
          throw new Error('Compute output transfer failed');
        }
        return { bytes: output.stdout, stdout: new TextDecoder().decode(command.stdout),
          stderr: new TextDecoder().decode(command.stderr), exitCode: command.exitCode };
      };
      return await Promise.race([run(), stopped]);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      // Process kill does not reach descendants. Destroy the VM even after successful commands.
      try { await this.container.destroy('Compute operation finished'); }
      finally { this.busy = false; }
    }
  }
}
