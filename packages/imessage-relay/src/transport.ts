import { iMessageCommandSchema, iMessageResultSchema, disabledIMessageCapabilities, type IMessageCapabilities, type IMessageCommand, type IMessageResult, type IMessageEvent } from '@waldo/contracts';
import { z } from 'zod';
import { parsedSyntheticIMessageEvents } from '../../contracts/src/channels/imessage-v1-fixtures';
export interface IMessageTransport {
  probe(): Promise<IMessageCapabilities>;
  history(generation: string, cursor: string | null): Promise<Readonly<{ generation: string; cursor: string | null; events: readonly IMessageEvent[] }>>;
  execute(command: IMessageCommand): Promise<IMessageResult>;
}
export class MockTransport implements IMessageTransport {
  executions = 0;
  constructor(private caps: IMessageCapabilities, private action?: (command: IMessageCommand) => Promise<IMessageResult>) {}
  async probe() { return structuredClone(this.caps); }
  async history(generation: string, cursor: string | null) {
    const events = Object.values(parsedSyntheticIMessageEvents);
    const sample = events[0]!;
    if (generation !== sample.cursor.databaseGeneration || (cursor !== null && cursor !== sample.cursor.value)) throw new Error('fixture history cursor mismatch');
    return { generation, cursor: sample.cursor.value, events: cursor === null ? structuredClone(events) : [] };
  }
  async execute(input: IMessageCommand) {
    const command = iMessageCommandSchema.parse(input); this.executions++;
    return iMessageResultSchema.parse(this.action ? await this.action(command) : { version: 1, commandId: command.commandId, target: command.target, state: 'local_recorded', messageGuid: 'fixture-native-guid', evidence: { kind: 'local_database', reference: 'synthetic-local-row' } });
  }
}
const rpcResponse = z.union([
  z.strictObject({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.unknown() }),
  z.strictObject({ jsonrpc: z.literal('2.0'), id: z.string().nullable(), error: z.strictObject({ code: z.int(), message: z.string(), data: z.unknown().optional() }) }),
]);
const statusSchema = z.object({ protocol_version: z.literal(1), version: z.string().min(1), methods: z.array(z.string()), supported_methods: z.array(z.string()), database: z.object({ ready: z.boolean() }) });
export type RpcExchange = (line: string) => Promise<string>;

// Caller supplies a fixture exchange. This scaffold never starts a native process.
export class ImsgRelayTransport implements IMessageTransport {
  private sequence = 0;
  constructor(private bridgeId: string, private accountId: string, private exchange: RpcExchange) {}
  private async rpc(method: string, params: Record<string, unknown>) {
    const id = String(++this.sequence);
    const line = await this.exchange(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = rpcResponse.parse(JSON.parse(line));
    if (response.id !== id || 'error' in response) throw new Error('imsg protocol response unavailable');
    return response.result;
  }
  async probe() {
    const status = statusSchema.parse(await this.rpc('status', {}));
    const caps = disabledIMessageCapabilities(this.bridgeId, this.accountId);
    return { ...caps, transport: 'imsg' as const, transportVersion: status.version, readiness: status.database.ready ? 'unverified' as const : 'offline' as const };
  }
  async history(generation: string, cursor: string | null): Promise<Readonly<{ generation: string; cursor: string | null; events: readonly IMessageEvent[] }>> {
    // A status result cannot attest the caller's database generation or cursor.
    void generation; void cursor;
    throw new Error('native generation and history unverified');
  }
  async execute(command: IMessageCommand): Promise<IMessageResult> {
    iMessageCommandSchema.parse(command);
    return { version: 1, commandId: command.commandId, target: command.target, state: 'rejected', disposition: 'not_started', reason: 'native_host_unverified' };
  }
}
