import {z} from 'zod';
const utf8Bytes=(value:string):number=>Array.from(value).reduce((size,char)=>{const code=char.codePointAt(0)!;return size+(code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4);},0);
const text=(max:number)=>z.string().min(1).refine(value=>utf8Bytes(value)<=max && !value.includes('\u0000'),{message:`UTF-8 text must fit ${max} bytes`});
const common={project:text(128),reason:text(512)};
const session_id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
// The validation truth: one strict shape per action.
const useMacActionSchema=z.discriminatedUnion('action',[
 z.strictObject({...common,action:z.literal('run_command'),command:text(4096),timeout_seconds:z.int().min(1).max(600).default(120)}),
 z.strictObject({...common,action:z.literal('list_sessions')}),
 z.strictObject({...common,action:z.literal('read_session'),session_id}),
 z.strictObject({...common,action:z.literal('start_session'),agent:z.enum(['claude-code','codex']),prompt:text(4096)}),
 z.strictObject({...common,action:z.literal('message_session'),session_id,prompt:text(4096)}),
 z.strictObject({...common,action:z.literal('interrupt_session'),session_id}),
 z.strictObject({...common,action:z.literal('stop_session'),session_id}),
]);
// What the model is shown: one object, since a provider may refuse a tool whose parameters are a union at the root (Anthropic does).
// It is only the front of the pipe below, so it admits exactly the keys the actions use and the action schema above decides the rest.
const useMacWireSchema=z.strictObject({
 ...common,
 action:z.enum(['run_command','list_sessions','read_session','start_session','message_session','interrupt_session','stop_session']),
 command:text(4096).optional().describe('Required for the run_command action; not allowed for any other.'),
 timeout_seconds:z.int().min(1).max(600).optional().describe('Optional for the run_command action (seconds, default 120); not allowed for any other.'),
 session_id:session_id.optional().describe('Required for the read_session, message_session, interrupt_session and stop_session actions; not allowed for any other.'),
 agent:z.enum(['claude-code','codex']).optional().describe('Required for the start_session action; not allowed for any other.'),
 prompt:text(4096).optional().describe('Required for the start_session and message_session actions; not allowed for any other.'),
});
export const useMacArgsSchema=useMacWireSchema.pipe(useMacActionSchema);
export type UseMacArgs=z.infer<typeof useMacActionSchema>;
