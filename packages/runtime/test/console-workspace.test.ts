import { expect, it } from 'vitest';
import { workspaceDownload, workspacePage } from '../src/channels/console-workspace';
import type { FileMeta } from '../../workspace/src/store';
const meta:FileMeta={file_id:'fixture',path:'<script>alert(1)</script>.txt',revision:1,mime:'text/html',byte_size:3,sha256:'fixture',provenance:'owner_upload',source_taint:'external',created_at:0,updated_at:0,state:'ready'};
it('uses private opaque attachment with encoded filename, no executable MIME or public link',async()=>{
 const r=workspaceDownload(new Uint8Array([0,1,2]),meta);expect(r.headers.get('content-type')).toBe('application/octet-stream');expect(r.headers.get('cache-control')).toBe('private, no-store');expect(r.headers.get('content-disposition')).not.toContain('<script>');expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([0,1,2]));
});
it('escapes hostile paths and shows honest absent controls/empty state',async()=>{
 const r=workspacePage([meta], 'token<canary>', 'cursor');const html=await r.text();expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('action="/console/workspace/upload"');expect(html).toContain('token&lt;canary&gt;');expect(html).toContain('/console/workspace?cursor=cursor');expect(r.headers.get('content-security-policy')).toContain("form-action 'self'");expect(html).not.toContain('<script');expect(await workspacePage([], 'csrf', null).text()).toContain('No retained files.');
});
