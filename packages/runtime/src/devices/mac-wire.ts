import { byteString, exact, identifier, record } from './wire';

export type MacPayload = { action?: string; project: string; reason?: string; command?: string; timeout_seconds?: number; session_id?: string; agent?: 'claude-code' | 'codex'; prompt?: string };
export const macClass = (value: unknown): boolean => ['shell_exec','session_query','session_control'].includes(String(value));
export function macCommandPayload(kind: unknown, value: unknown): value is MacPayload {
 if (!record(value) || !byteString(value.project,1,128)) return false;
 if (kind === 'shell_exec') return exact(value,['project','command','reason','timeout_seconds']) && byteString(value.command,1,4096) && byteString(value.reason,1,512) && Number.isInteger(value.timeout_seconds) && Number(value.timeout_seconds)>=1 && Number(value.timeout_seconds)<=600;
 if (kind === 'session_query') return value.action==='list_sessions' ? exact(value,['action','project']) : value.action==='read_session' && exact(value,['action','project','session_id']) && identifier(value.session_id);
 if (kind !== 'session_control' || !byteString(value.reason,1,512)) return false;
 if (value.action==='start_session') return exact(value,['action','project','reason','agent','prompt']) && ['claude-code','codex'].includes(String(value.agent)) && byteString(value.prompt,1,4096);
 if (value.action==='message_session') return exact(value,['action','project','reason','session_id','prompt']) && identifier(value.session_id) && byteString(value.prompt,1,4096);
 return ['interrupt_session','stop_session'].includes(String(value.action)) && exact(value,['action','project','reason','session_id']) && identifier(value.session_id);
}
export function macResultPayload(value: Record<string,unknown>): boolean {
 if (['denied','expired','outcome_unknown'].includes(String(value.status))) return exact(value,['status']);
 if (value.status==='completed') return exact(value,value.session_id===undefined?['status','exit_code','output_tail','truncated']:['status','exit_code','output_tail','truncated','session_id']) && Number.isInteger(value.exit_code) && Number(value.exit_code)>=-2147483648 && Number(value.exit_code)<=2147483647 && byteString(value.output_tail,0,6144) && typeof value.truncated==='boolean' && (value.session_id===undefined || identifier(value.session_id));
 if (value.status!=='answered' || !exact(value,['status','answer']) || !record(value.answer)) return false;
 const a=value.answer;
 if (exact(a,['session_id','status','output_tail','truncated'])) return identifier(a.session_id) && byteString(a.status,1,64) && byteString(a.output_tail,0,6144) && typeof a.truncated==='boolean';
 return exact(a,['sessions','truncated']) && Array.isArray(a.sessions) && a.sessions.length<=20 && typeof a.truncated==='boolean' && a.sessions.every(s=>record(s) && exact(s,['session_id','project','agent','status']) && identifier(s.session_id) && byteString(s.project,1,128) && ['codex','claude-code'].includes(String(s.agent)) && byteString(s.status,1,64));
}
export function resultMatchesMacCommand(kind: string, p: MacPayload, result: Record<string,unknown>): boolean {
 if (result.status==='failed') return result.reason==='processing_failed';
 if (['denied','expired','outcome_unknown'].includes(String(result.status))) return kind!=='session_query' || result.status==='expired';
 if (kind==='session_query') {
  if (result.status!=='answered' || !record(result.answer)) return false;
  return p.action==='list_sessions' ? Array.isArray(result.answer.sessions) && result.answer.sessions.every(s=>record(s) && s.project===p.project) : result.answer.session_id===p.session_id;
 }
 if(result.status!=='completed') return false;
 return kind==='shell_exec' ? result.session_id===undefined : identifier(result.session_id) && (p.action==='start_session' || result.session_id===p.session_id);
}
