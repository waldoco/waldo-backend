const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 4_096;

export class ResponsibilityJsonAdmissionError extends Error {
  constructor() {
    super('responsibility JSON rejected');
    this.name = 'ResponsibilityJsonAdmissionError';
  }
}

export function parseResponsibilityJsonBytes(
  bytes: Uint8Array,
  maximumBytes = 24_576,
): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new ResponsibilityJsonAdmissionError();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ResponsibilityJsonAdmissionError();
  }
  new DuplicateAwareJsonScanner(text).scan();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ResponsibilityJsonAdmissionError();
  }
}

export async function readBoundedResponsibilityBody(
  request: Request,
  maximumBytes = 24_576,
): Promise<Uint8Array> {
  if (request.body === null) throw new ResponsibilityJsonAdmissionError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ResponsibilityJsonAdmissionError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ResponsibilityJsonAdmissionError) throw error;
    throw new ResponsibilityJsonAdmissionError();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class DuplicateAwareJsonScanner {
  #index = 0;
  #nodes = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.#skipWhitespace();
    this.#value(0);
    this.#skipWhitespace();
    if (this.#index !== this.text.length) this.#reject();
  }

  #value(depth: number): void {
    this.#nodes += 1;
    if (depth > MAX_JSON_DEPTH || this.#nodes > MAX_JSON_NODES) this.#reject();
    const character = this.text[this.#index];
    if (character === '{') return this.#object(depth);
    if (character === '[') return this.#array(depth);
    if (character === '"') {
      this.#string();
      return;
    }
    if (character === 't') return this.#literal('true');
    if (character === 'f') return this.#literal('false');
    if (character === 'n') return this.#literal('null');
    this.#number();
  }

  #object(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    const keys = new Set<string>();
    if (this.text[this.#index] === '}') {
      this.#index += 1;
      return;
    }
    while (true) {
      if (this.text[this.#index] !== '"') this.#reject();
      const key = this.#string();
      if (keys.has(key)) this.#reject();
      keys.add(key);
      this.#skipWhitespace();
      if (this.text[this.#index] !== ':') this.#reject();
      this.#index += 1;
      this.#skipWhitespace();
      this.#value(depth + 1);
      this.#skipWhitespace();
      const separator = this.text[this.#index];
      if (separator === '}') {
        this.#index += 1;
        return;
      }
      if (separator !== ',') this.#reject();
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #array(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.text[this.#index] === ']') {
      this.#index += 1;
      return;
    }
    while (true) {
      this.#value(depth + 1);
      this.#skipWhitespace();
      const separator = this.text[this.#index];
      if (separator === ']') {
        this.#index += 1;
        return;
      }
      if (separator !== ',') this.#reject();
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.text.length) {
      const codeUnit = this.text.charCodeAt(this.#index);
      if (codeUnit === 0x22) {
        this.#index += 1;
        let decoded: unknown;
        try {
          decoded = JSON.parse(this.text.slice(start, this.#index));
        } catch {
          this.#reject();
        }
        if (typeof decoded !== 'string' || !isWellFormedUtf16(decoded)) this.#reject();
        return decoded;
      }
      if (codeUnit < 0x20) this.#reject();
      if (codeUnit === 0x5c) {
        this.#index += 1;
        const escaped = this.text[this.#index];
        if (escaped === 'u') {
          if (!/^[a-fA-F0-9]{4}$/.test(this.text.slice(this.#index + 1, this.#index + 5))) {
            this.#reject();
          }
          this.#index += 5;
          continue;
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) this.#reject();
      }
      this.#index += 1;
    }
    this.#reject();
  }

  #number(): void {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.#index),
    );
    if (match === null) this.#reject();
    this.#index += match[0].length;
  }

  #literal(literal: string): void {
    if (this.text.slice(this.#index, this.#index + literal.length) !== literal) this.#reject();
    this.#index += literal.length;
  }

  #skipWhitespace(): void {
    while (/\s/.test(this.text[this.#index] ?? '') &&
      ' \t\r\n'.includes(this.text[this.#index] ?? '')) {
      this.#index += 1;
    }
  }

  #reject(): never {
    throw new ResponsibilityJsonAdmissionError();
  }
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
