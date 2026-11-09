import {expect,it} from 'vitest';
import {mcpErrorDiagnostic,safeMcpErrorDiagnostic} from '../src/connectors/mcp-error-diagnostic';
const canary='PRIVATE_FILE_TOKEN_CANARY';
const error=(reason='SERVICE_DISABLED',domain='googleapis.com',service='drivemcp.googleapis.com')=>({error:{status:'PERMISSION_DENIED',message:canary,details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason,domain,metadata:{service,consumer:canary,activationUrl:`https://console.cloud.google.com/${canary}`,access_token:canary}}]}});
it('extracts only closed Google RPC diagnostics from structured or JSON-valued text content',()=>{
 const expected={stage:'tools/call',provider_status:'PERMISSION_DENIED',reason:'SERVICE_DISABLED',service:'drivemcp.googleapis.com'};
 expect(mcpErrorDiagnostic({structuredContent:error()})).toEqual(expected);
 expect(mcpErrorDiagnostic({content:[{type:'text',text:JSON.stringify(error())}]})).toEqual(expected);
 expect(JSON.stringify(mcpErrorDiagnostic({structuredContent:error()}))).not.toContain(canary);
});
it('unstructured provider content is unknown, not guessed from status or reason words',()=>{
 expect(mcpErrorDiagnostic({content:[{type:'text',text:`SERVICE_DISABLED PERMISSION_DENIED ${canary}`}]})).toEqual({stage:'tools/call'});
 expect(mcpErrorDiagnostic({structuredContent:{files:[{title:canary}]}})).toEqual({stage:'tools/call'});
});
it('wrong-domain details, unknown codes and arbitrary metadata cannot become diagnostics',()=>{
 expect(mcpErrorDiagnostic({structuredContent:error(canary,'evil.invalid',canary)})).toEqual({stage:'tools/call',provider_status:'PERMISSION_DENIED'});
 expect(mcpErrorDiagnostic({structuredContent:error(canary)})).toEqual({stage:'tools/call',provider_status:'PERMISSION_DENIED',service:'drivemcp.googleapis.com'});
 expect(safeMcpErrorDiagnostic({stage:'tools/call',provider_status:canary,reason:canary,service:canary,message:canary})).toEqual({stage:'tools/call'});
 expect(safeMcpErrorDiagnostic({stage:canary,reason:'SERVICE_DISABLED'})).toBeUndefined();
});
