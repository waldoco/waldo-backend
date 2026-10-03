import { renderBlock, renderSkill, skillSchema, type Skill, type TriggerType } from '@waldo/contracts';
import { SKILLS_TABLE_SCHEMA } from '../do-schema';
import { RuntimeSkillLoader } from './loader';
import type { ResolvedSkillBudget } from './budget';

const NAME = 'document-email-preparation';
const SOURCE = 'reviewed-builtin:document-email-preparation@1';
// Reviewed, instruction-only catalog. Workspace files and provider content cannot contribute rows.
export const CURATED_PREPARATION_SKILL: Skill = Object.freeze(skillSchema.parse({
 name: NAME, version: 1, provenance: 'system', identity_locked: true, provisional: false,
 trigger_types: ['user_message', 'brief'], trigger_condition: 'Prepare or revise a document or email draft from owner-provided facts.',
 required_tools: [], required_connectors: [], effectiveness: 1, invocations: 0, last_used: null,
 body_markdown: 'Prepare a reviewable draft. Identify audience, purpose and missing facts; ask only for essentials. Separate verified facts from assumptions. Keep recipient, subject and draft clear. For saved drafts, list/read the current file and revise with its exact revision; on conflict re-read. Across turns, recover the saved draft before revising. Check factual claims, commitments and requested tone. Report saved file identity/revision. Sending needs separate owner approval.',
 created_at: '2026-10-01T00:00:00Z',
}));
Object.freeze(CURATED_PREPARATION_SKILL.trigger_types);
Object.freeze(CURATED_PREPARATION_SKILL.required_tools);
Object.freeze(CURATED_PREPARATION_SKILL.required_connectors);

// Conservative upper bound for byte-level BPE: each token consumes at least one UTF-8 byte.
// This is deliberately NOT an exact tokenizer count or a chars/4 estimate. The entire rendered
// fragment/fence is measured; a compact reviewed instruction-only skill fits the existing cap.
export function byteUpperBoundSkillBudget(): ResolvedSkillBudget {
 const count = async (text: string) => ({ ok: true as const, tokens: new TextEncoder().encode(text).length });
 return Object.freeze({ countRenderedSkill: count, countRenderedBlock: count });
}
export type CuratedSkillTurn = Readonly<{
 owner: string; custodyKey?: string; turnId: string; trigger: TriggerType; ownerText: string;
 assertCurrent(): Promise<void>;
}>;
type Result = { ok: true; source_taint: null; data: { name: string; version: number; enabled: boolean; source: string } }
 | { ok: false; code: 'rejected'; error: string };
const denied = (): Result => ({ok:false,code:'rejected',error:'Skill version, source, owner permission or enabled state is unavailable.'});
const metadata = (enabled: boolean) => ({name:NAME,version:1,enabled,source:SOURCE});
type Stored = { version:number; provenance:string; identity_locked:number; provisional:number; trigger_types_json:string;
 trigger_condition:string; required_tools_json:string; required_connectors_json:string; body_markdown:string; created_by:string;
 created_at:string; status:string; effectiveness:number; pinned:number; invocations:number; last_used:string|null; last_curated_at:string|null; archived_at:string|null };

export class CuratedOwnerSkills {
 readonly #selected = new Map<string,string>();
 constructor(private readonly sql: SqlStorage, private readonly owner: string,
  private readonly budget: ResolvedSkillBudget = byteUpperBoundSkillBudget(), private readonly custodyKey: string = owner) { this.sql.exec(SKILLS_TABLE_SCHEMA); }
 list() { return [{...metadata(this.active()),description:CURATED_PREPARATION_SKILL.trigger_condition, budget:'conservative_utf8_byte_upper_bound', tools:[] as string[], scripts:false}]; }
 install(name:string,version:number,turn:CuratedSkillTurn):Result {
  if(!this.authorized(name,version,turn,'install')) return denied();
  const current=this.stored();
  if(current && !this.authentic(current)) return denied();
  const s=CURATED_PREPARATION_SKILL;
  this.sql.exec(`INSERT INTO skills(name,version,provenance,identity_locked,provisional,trigger_types_json,trigger_condition,required_tools_json,required_connectors_json,effectiveness,invocations,last_used,body_markdown,created_at,created_by,status,pinned,last_curated_at,archived_at)
   VALUES(?,1,'system',1,0,?,?, '[]','[]',1,0,NULL,?,? ,?,'active',1,NULL,NULL)
   ON CONFLICT(name) DO UPDATE SET status='active',archived_at=NULL`,name,JSON.stringify(s.trigger_types),s.trigger_condition,s.body_markdown,s.created_at,`${SOURCE}:owner:${this.custodyKey}`);
  return {ok:true,source_taint:null,data:metadata(true)};
 }
 disable(name:string,version:number,turn:CuratedSkillTurn):Result {
  if(!this.authorized(name,version,turn,'disable')) return denied();
  const row=this.stored();
  if(row&&!this.authentic(row)) return denied();
  this.sql.exec("UPDATE skills SET status='archived' WHERE name=?",NAME);
  this.#selected.clear();
  return {ok:true,source_taint:null,data:metadata(false)};
 }
 load(name:string,version:number,turn:CuratedSkillTurn):Result {
  if(turn.owner!==this.owner || !turn.turnId || name!==NAME || version!==1 || !CURATED_PREPARATION_SKILL.trigger_types.includes(turn.trigger) || !this.active()) return denied();
  this.#selected.set(turn.turnId,`${name}@${version}`);
  return {ok:true,source_taint:null,data:metadata(true)};
 }
 async prompt(turn:CuratedSkillTurn,canaryTokens:readonly string[]):Promise<string> {
  await turn.assertCurrent();
  if(turn.owner!==this.owner || this.#selected.get(turn.turnId)!==`${NAME}@1` || !this.active()) return '';
  const before=JSON.stringify(this.stored());
  const loader=new RuntimeSkillLoader({systemSkills:[CURATED_PREPARATION_SKILL],connectorSkills:[],mutableReader:{load:async()=>({ok:true,skills:[]})}});
  const result=await loader.loadForTrigger({trigger:turn.trigger,canaryTokens:[...canaryTokens],connectedConnectors:new Set(),dismissedToday:new Set(),provisionalReverted:new Set(),identityDrift:new Set(),priorityPinned:new Set(),skillBudget:this.budget});
  await turn.assertCurrent();
  if(!this.active() || JSON.stringify(this.stored())!==before || this.#selected.get(turn.turnId)!==`${NAME}@1`) return '';
  return renderBlock(result.selected.map(renderSkill));
 }
 private authorized(name:string,version:number,turn:CuratedSkillTurn,action:'install'|'disable') {
  return turn.owner===this.owner && Boolean(turn.turnId) && turn.trigger==='user_message' && name===NAME && version===1
   && turn.ownerText.trim()===`/skills ${action} ${NAME}@1`;
 }
 private stored():Stored|undefined {
  return this.sql.exec<Stored>('SELECT version,provenance,identity_locked,provisional,trigger_types_json,trigger_condition,required_tools_json,required_connectors_json,body_markdown,created_by,created_at,status,effectiveness,pinned,invocations,last_used,last_curated_at,archived_at FROM skills WHERE name=?',NAME).toArray()[0];
 }
 private authentic(row:Stored):boolean {
  const s=CURATED_PREPARATION_SKILL;
  return row.version===1 && row.provenance==='system' && row.identity_locked===1 && row.provisional===0
   && row.trigger_types_json===JSON.stringify(s.trigger_types) && row.trigger_condition===s.trigger_condition
   && row.required_tools_json==='[]' && row.required_connectors_json==='[]' && row.body_markdown===s.body_markdown
   && row.created_by===`${SOURCE}:owner:${this.custodyKey}` && row.created_at===s.created_at && row.effectiveness===1 && row.pinned===1 && row.invocations===0
   && row.last_used===null && row.last_curated_at===null && row.archived_at===null && ['active','archived'].includes(row.status);
 }
 private active():boolean {const row=this.stored(); return row!==undefined && this.authentic(row)&&row.status==='active';}
}
