import { env, runInDurableObject } from 'cloudflare:test';
import { expect,it } from 'vitest';
import { buildSessionState, TOOL_PERMISSIONS, skillsVersionArgsSchema, skillsListArgsSchema, handlerAllowlistMatchesAcl } from '@waldo/contracts';
import { createScopedCuratedSkillCapability } from '../src/skills/curated-host';
import { CURATED_SKILLS, CuratedOwnerSkills } from '../src/skills/curated-owner';
import { dispatchTool } from '../src/tools/dispatcher';
import { sanitise } from '../src/scribe/sanitiser';
const canaries=['0123456789abcdef','fedcba9876543210','0011223344556677'];
it('strict schemas, registry ACL and taint gate cover every lifecycle entry',async()=>{
 expect(skillsVersionArgsSchema.safeParse({name:'document-email-preparation',version:1,body:'forged'}).success).toBe(false);
 expect(skillsListArgsSchema.safeParse({path:'SKILL.md'}).success).toBe(false);
 const stub=env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName('curated-skills-tools'));
 await runInDurableObject(stub,async(_,state)=>{
  let closed=false;const scope={runId:'run',attempt:'attempt',deadline:Date.now()+60000,signal:new AbortController().signal,admit(){if(closed)throw new Error('closed');},commit<T>(work:()=>T){this.admit();return work();}};
  const turn={owner:'owner',turnId:'turn',trigger:'user_message' as const,ownerText:'/skills install document-email-preparation@1',assertCurrent:async()=>scope.admit()};
  const cap=createScopedCuratedSkillCapability(state.storage.sql,turn,scope);
  for(const handler of cap.handlers)expect(handlerAllowlistMatchesAcl(handler.name,handler.trigger_allowlist)).toBe(true);
  expect(TOOL_PERMISSIONS.brief).not.toContain('skills_install');expect(TOOL_PERMISSIONS.brief).not.toContain('skills_disable');
  const ctx={authenticatedUserId:'owner',turnId:'turn',runScope:scope,trigger:'user_message' as const,canaryTokens:canaries,session:buildSessionState({trigger:'user_message',canary_tokens:canaries,started_at:1}),hasApproval:()=>true,sourceTaint:null,toolArgSourceTaint:null,sanitise};
  const call=(name:'skills_install'|'skills_load',overrides={})=>dispatchTool({id:'call',name,args:{name:'document-email-preparation',version:1}},{...ctx,...overrides},{handlers:cap.handlers});
  expect(await call('skills_install',{toolArgSourceTaint:'external'})).toMatchObject({ok:false});
  expect(await call('skills_install',{authenticatedUserId:'other'})).toMatchObject({ok:false});
  expect(await call('skills_install',{turnId:'wrong'})).toMatchObject({ok:false});
  expect(await call('skills_install',{runScope:{...scope,runId:'other'}})).toMatchObject({ok:false});
  expect(await call('skills_install',{runScope:{...scope,admit:()=>{}}})).toMatchObject({ok:false});
  const installed=await call('skills_install');expect(installed).toMatchObject({ok:true});
  expect(await call('skills_load')).toMatchObject({ok:true});
  expect(await cap.prompt(canaries)).toContain('Prepare a reviewable draft.');
  closed=true;await expect(cap.prompt(canaries)).rejects.toThrow('closed');
 });
});
it('renders the catalog as one line per skill with name, version, description and enabled state, smaller than JSON',async()=>{
 const stub=env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName('curated-skills-catalog-lines'));
 await runInDurableObject(stub,async(_,state)=>{
  const scope={runId:'run',attempt:'attempt',deadline:Date.now()+60000,signal:new AbortController().signal,admit(){},commit<T>(work:()=>T){return work();}};
  const turn={owner:'owner',turnId:'turn',trigger:'user_message' as const,ownerText:'/skills disable day-brief',assertCurrent:async()=>{}};
  const book=new CuratedOwnerSkills(state.storage.sql,'owner');
  const day=CURATED_SKILLS.find(s=>s.name==='day-brief')!;
  expect(book.disable(day.name,day.version,turn).ok).toBe(true);
  const catalog=createScopedCuratedSkillCapability(state.storage.sql,turn,scope).metadata();
  const lines=catalog.split('\n');
  for(const s of CURATED_SKILLS){
   const line=lines.filter(l=>l.startsWith(`- ${s.name}@${s.version} `));
   expect(line,s.name).toHaveLength(1);
   expect(line[0]).toContain(s.trigger_condition);
   expect(line[0]!.endsWith(s.name===day.name?'(disabled)':'(enabled)')).toBe(true);
  }
  expect(catalog.startsWith('Reviewed skill catalog (metadata only)')).toBe(true);
  expect(catalog).toContain('skills_load');
  expect(catalog).toContain('Disabled skills cannot load');
  expect(catalog).not.toContain('{');
  expect(catalog.length).toBeLessThan(JSON.stringify(book.list()).length);
 });
});
