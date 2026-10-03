import { renderBlock, renderSkill, skillSchema, type Skill, type TriggerType } from '@waldo/contracts';
import { SKILLS_TABLE_SCHEMA } from '../do-schema';
import { RuntimeSkillLoader } from './loader';
import { CURATED_PACK_SKILLS } from './curated-catalog';
import type { ResolvedSkillBudget } from './budget';

const NAME = 'document-email-preparation';
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
export const CURATED_SKILLS: readonly Skill[] = Object.freeze([CURATED_PREPARATION_SKILL, ...CURATED_PACK_SKILLS]);
const skillFor = (name: string): Skill | undefined => CURATED_SKILLS.find(s => s.name === name);
const sourceOf = (name: string) => `reviewed-builtin:${name}@1`;

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
const metadata = (name: string, enabled: boolean) => ({name,version:1,enabled,source:sourceOf(name)});
type Stored = { version:number; provenance:string; identity_locked:number; provisional:number; trigger_types_json:string;
 trigger_condition:string; required_tools_json:string; required_connectors_json:string; body_markdown:string; created_by:string;
 admitted:number; created_at:string; status:string; effectiveness:number; pinned:number; invocations:number; last_used:string|null; last_curated_at:string|null; archived_at:string|null };

// SQL projects only bounded text into JS, retaining a rejected row's presence so install
// cannot mistake hostile storage for absence and reactivate it through ON CONFLICT.
const TEXT_FIELDS = [
 ['provenance',32,false],
 ['trigger_types_json',1024,false], ['trigger_condition',800,false],
 ['required_tools_json',1024,false], ['required_connectors_json',1024,false],
 ['body_markdown',2400,false], ['created_by',256,false], ['created_at',64,false],
 ['status',16,false], ['last_used',64,true], ['last_curated_at',64,true], ['archived_at',64,true],
] as const;
const NUMERIC_FIELDS = ['version','identity_locked','provisional','pinned','invocations','effectiveness'] as const;
const boundedText = (field:string,limit:number,nullable:boolean) =>
 `(${nullable ? `${field} IS NULL OR ` : ''}(typeof(${field}) = 'text' AND length(CAST(${field} AS BLOB)) <= ${limit}))`;
const boundedNumber = (field:string) => `typeof(${field}) IN ('integer','real')`;
const STORAGE_GUARDS = [...TEXT_FIELDS.map(([field,limit,nullable])=>boundedText(field,limit,nullable)),...NUMERIC_FIELDS.map(boundedNumber)];
const STORED_ROW_QUERY = `SELECT CASE WHEN ${STORAGE_GUARDS.join(' AND ')} THEN 1 ELSE 0 END AS admitted,
 ${[...TEXT_FIELDS.map(([field,limit,nullable])=>`CASE WHEN ${boundedText(field,limit,nullable)} THEN ${field} ELSE NULL END AS ${field}`),
 ...NUMERIC_FIELDS.map(field=>`CASE WHEN ${boundedNumber(field)} THEN ${field} ELSE NULL END AS ${field}`)].join(', ')} FROM skills WHERE name=?`;

export class CuratedOwnerSkills {
 // One reviewed procedure per turn: a block of two would exceed the single-skill body ceiling.
 readonly #selected = new Map<string,string>();
 constructor(private readonly sql: SqlStorage, private readonly owner: string,
  private readonly budget: ResolvedSkillBudget = byteUpperBoundSkillBudget(), private readonly custodyKey: string = owner) { this.sql.exec(SKILLS_TABLE_SCHEMA); }
 list() { return CURATED_SKILLS.map(s=>({...metadata(s.name,this.active(s.name)),description:s.trigger_condition, budget:'conservative_utf8_byte_upper_bound', tools:[] as string[], scripts:false})); }
 install(name:string,version:number,turn:CuratedSkillTurn):Result {
  const s=skillFor(name);
  if(!s || !this.authorized(name,version,turn,'install')) return denied();
  const current=this.stored(name);
  if(current && !this.authentic(current,s)) return denied();
  this.sql.exec(`INSERT INTO skills(name,version,provenance,identity_locked,provisional,trigger_types_json,trigger_condition,required_tools_json,required_connectors_json,effectiveness,invocations,last_used,body_markdown,created_at,created_by,status,pinned,last_curated_at,archived_at)
   VALUES(?,1,'system',1,0,?,?, '[]','[]',1,0,NULL,?,? ,?,'active',1,NULL,NULL)
   ON CONFLICT(name) DO UPDATE SET status='active',archived_at=NULL`,name,JSON.stringify(s.trigger_types),s.trigger_condition,s.body_markdown,s.created_at,`${sourceOf(name)}:owner:${this.custodyKey}`);
  return {ok:true,source_taint:null,data:metadata(name,true)};
 }
 disable(name:string,version:number,turn:CuratedSkillTurn):Result {
  const s=skillFor(name);
  if(!s || !this.authorized(name,version,turn,'disable')) return denied();
  const row=this.stored(name);
  if(row&&!this.authentic(row,s)) return denied();
  this.sql.exec("UPDATE skills SET status='archived' WHERE name=?",name);
  for(const [turnId,selected] of [...this.#selected]) if(selected===name) this.#selected.delete(turnId);
  return {ok:true,source_taint:null,data:metadata(name,false)};
 }
 load(name:string,version:number,turn:CuratedSkillTurn):Result {
  const s=skillFor(name);
  if(!s || turn.owner!==this.owner || !turn.turnId || version!==1 || !s.trigger_types.includes(turn.trigger) || !this.active(name)) return denied();
  const prior=this.#selected.get(turn.turnId);
  if(prior!==undefined && prior!==name) return denied();
  this.#selected.set(turn.turnId,name);
  return {ok:true,source_taint:null,data:metadata(name,true)};
 }
 async prompt(turn:CuratedSkillTurn,canaryTokens:readonly string[]):Promise<string> {
  await turn.assertCurrent();
  const name=this.#selected.get(turn.turnId);
  const s=name===undefined?undefined:skillFor(name);
  if(!name || !s || turn.owner!==this.owner || !this.active(name)) return '';
  const before=JSON.stringify(this.stored(name));
  const loader=new RuntimeSkillLoader({systemSkills:[s],connectorSkills:[],mutableReader:{load:async()=>({ok:true,skills:[]})}});
  const result=await loader.loadForTrigger({trigger:turn.trigger,canaryTokens:[...canaryTokens],connectedConnectors:new Set(),dismissedToday:new Set(),provisionalReverted:new Set(),identityDrift:new Set(),priorityPinned:new Set(),skillBudget:this.budget});
  await turn.assertCurrent();
  if(!this.active(name) || JSON.stringify(this.stored(name))!==before || this.#selected.get(turn.turnId)!==name) return '';
  return renderBlock(result.selected.map(renderSkill));
 }
 private authorized(name:string,version:number,turn:CuratedSkillTurn,action:'install'|'disable') {
  return turn.owner===this.owner && Boolean(turn.turnId) && turn.trigger==='user_message' && version===1
   && turn.ownerText.trim()===`/skills ${action} ${name}@1`;
 }
 private stored(name:string):Stored|undefined {
  return this.sql.exec<Stored>(STORED_ROW_QUERY,name).toArray()[0];
 }
 private authentic(row:Stored,s:Skill):boolean {
  return row.admitted===1 && row.version===1 && row.provenance==='system' && row.identity_locked===1 && row.provisional===0
   && row.trigger_types_json===JSON.stringify(s.trigger_types) && row.trigger_condition===s.trigger_condition
   && row.required_tools_json==='[]' && row.required_connectors_json==='[]' && row.body_markdown===s.body_markdown
   && row.created_by===`${sourceOf(s.name)}:owner:${this.custodyKey}` && row.created_at===s.created_at && row.effectiveness===1 && row.pinned===1 && row.invocations===0
   && row.last_used===null && row.last_curated_at===null && row.archived_at===null && ['active','archived'].includes(row.status);
 }
 private active(name:string):boolean {const s=skillFor(name); const row=this.stored(name); return s!==undefined && row!==undefined && this.authentic(row,s)&&row.status==='active';}
}
