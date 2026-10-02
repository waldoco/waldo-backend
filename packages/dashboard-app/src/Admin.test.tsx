import { describe,it,expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardNavigation, resolveRoute } from './App';
import { quota,pageRows,inviteStatus } from './admin-model';
describe('restricted admin presentation',()=>{
 it('does not advertise admin to non-admin and selects restricted entry only when backed',()=>{
  expect(renderToStaticMarkup(<DashboardNavigation route="today"/>)).not.toContain('#/admin');
  const html=renderToStaticMarkup(<DashboardNavigation route="admin" isAdmin/>);
  expect(html).toContain('href="#/admin"');expect(html).toContain('aria-current="page"');expect(resolveRoute('admin')).toBe('admin');
 });
 it('counts every issued code and clamps only remaining quota',()=>{
  expect(quota(5)).toEqual({used:5,remaining:0});expect(quota(7)).toEqual({used:7,remaining:0});expect(quota(2).remaining).toBe(3);
  const base={id:'i',email:null,issued_by:null,issuer_email:null,created_at:'2026-09-01Z',expires_at:'2026-09-15Z',used_at:null,revoked_at:null};
  expect(inviteStatus(base,'2026-09-30Z')).toBe('expired');expect(inviteStatus({...base,used_at:'2026-09-02Z'},'2026-09-30Z')).toBe('used');expect(inviteStatus({...base,revoked_at:'2026-09-02Z'},'2026-09-30Z')).toBe('revoked');
 });
 it('keeps filtered pagination bounded including empty/no-match results',()=>{
  expect(pageRows([1,2],90)).toEqual({rows:[1,2],current:1,pages:1,total:2});expect(pageRows([],4).rows).toEqual([]);expect(pageRows(Array.from({length:21},(_,i)=>i),3).rows).toEqual([20]);
 });
});

import { vi } from 'vitest';
import { AdminPanel } from './Admin';
import { readAdmin,submitInvite,type AdminRecord } from './admin-model';
const admin:AdminRecord={csrf:'csrf',as_of:'2026-09-30T00:00:00Z',current_issuer:{id:'o',email:'admin@test.invalid',issued_count:5},owners:[{id:'o',email:'<script>@test.invalid',state:'active',presences:['telegram'],created_at:'2026-09-01T00:00:00Z',issued_count:5}],invites:[{id:'hash',email:'recipient@test.invalid',issued_by:'o',issuer_email:'<script>@test.invalid',created_at:'2026-09-29T00:00:00Z',expires_at:'2026-10-13T00:00:00Z',used_at:null,revoked_at:null}]};
describe('admin data and recovery',()=>{
 it('renders canonical attribution, exhausted quota, escaping and no recovered codes',()=>{
  const html=renderToStaticMarkup(<AdminPanel state={{kind:'ready',data:admin}} onRefresh={async()=>{}}/>);
  expect(html).toContain('5 of 5 codes issued');expect(html).toContain('0 remaining');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('>hash<');expect(html).toContain('Revoke invitation for');expect(html).toContain('disabled=""');
  const denied=renderToStaticMarkup(<AdminPanel state={{kind:'absent'}} onRefresh={async()=>{}}/>);
  expect(denied).not.toContain('Invite');expect(denied).not.toContain('/console/admin');expect(denied).toContain('Page not found');
 });
 it('requires actual issuer counts and strips unexpected code/secrets',()=>{
  expect(()=>readAdmin({...admin,current_issuer:undefined})).toThrow('projection');
  expect(readAdmin({...admin,code:'neverretain',secret:'neverretain'})).toEqual(admin);
 });
 it('turns a malformed successful receipt into honest unknown-outcome guidance',async()=>{
  const original=globalThis.fetch;globalThis.fetch=vi.fn(async()=>new Response('{',{status:200}));
  try{await expect(submitInvite(admin,'invite.create','recipient@test.invalid')).rejects.toThrow('code cannot be recovered');}finally{globalThis.fetch=original;}
 });
});

it('labels a lost transport response as unknown outcome rather than retryable failure',async()=>{
 const original=globalThis.fetch;globalThis.fetch=vi.fn(async()=>{throw new TypeError('Failed to fetch');});
 try{await expect(submitInvite(admin,'invite.create','a@test.invalid')).rejects.toThrow('Refresh records before retrying; a code cannot be recovered');}finally{globalThis.fetch=original;}
});

it('keeps a prepared signup link in the one-time receipt and rejects foreign link origins', async () => {
 const original = globalThis.fetch;
 vi.stubGlobal('location', { origin: 'https://w.test' });
 try {
  globalThis.fetch = vi.fn(async () => Response.json({ code: 'ABC', message: 'Prepared', link: 'https://w.test/console/signup#email=a%40test.invalid&invite=ABC' }));
  expect((await submitInvite(admin, 'invite.create', 'a@test.invalid')).link).toContain('/console/signup#');
  globalThis.fetch = vi.fn(async () => Response.json({ code: 'ABC', message: 'Prepared', link: 'https://foreign.test/console/signup#invite=ABC' }));
  await expect(submitInvite(admin, 'invite.create', 'a@test.invalid')).rejects.toThrow('link receipt is unavailable');
 } finally { globalThis.fetch = original; vi.unstubAllGlobals(); }
});
