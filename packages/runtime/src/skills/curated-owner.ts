import { renderBlock, renderSkill, type Skill, type TriggerType } from '@waldo/contracts';
import { SKILLS_TABLE_SCHEMA } from '../do-schema';
import { BUNDLED_SKILL_MAX_BYTES } from './bundled-file';
import { CURATED_PACK_SKILLS } from './curated-catalog';
import type { ResolvedSkillBudget } from './budget';

const NAME = 'document-email-preparation';
// Reviewed, instruction-only catalog. Workspace files and provider content cannot contribute rows.
export const CURATED_PREPARATION_SKILL: Skill = CURATED_PACK_SKILLS.find(s=>s.name===NAME)!;
export const CURATED_SKILLS: readonly Skill[] = Object.freeze([CURATED_PREPARATION_SKILL, ...CURATED_PACK_SKILLS.filter(s=>s.name!==NAME)]);
const sourceOf = (name: string, version: number) => `reviewed-builtin:${name}@${version}`;

// Conservative upper bound for byte-level BPE: each token consumes at least one UTF-8 byte.
// This is deliberately NOT an exact tokenizer count or a chars/4 estimate. The entire rendered
// fragment/fence is measured; bundled procedures and mutable skills have separate caps.
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
const metadata = (s: Skill, enabled: boolean) => ({name:s.name,version:s.version,enabled,source:sourceOf(s.name,s.version)});
type Stored = { version:number; provenance:string; identity_locked:number; provisional:number; trigger_types_json:string;
 trigger_condition:string; required_tools_json:string; required_connectors_json:string; body_markdown:string; created_by:string;
 admitted:number; created_at:string; status:string; effectiveness:number; pinned:number; invocations:number; last_used:string|null; last_curated_at:string|null; archived_at:string|null };

// SQL projects only bounded text into JS, retaining a rejected row's presence so install
// cannot mistake hostile storage for absence and reactivate it through ON CONFLICT.
const TEXT_FIELDS = [
 ['provenance',32,false],
 ['trigger_types_json',1024,false], ['trigger_condition',800,false],
 ['required_tools_json',1024,false], ['required_connectors_json',1024,false],
 ['body_markdown',BUNDLED_SKILL_MAX_BYTES,false], ['created_by',256,false], ['created_at',64,false],
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
 // One selected procedure per invocation; selection does not change tool admission.
 readonly #selected = new Map<string,string>();
 constructor(private readonly sql: SqlStorage, private readonly owner: string,
  private readonly budget: ResolvedSkillBudget = byteUpperBoundSkillBudget(), private readonly custodyKey: string = owner,
  private readonly catalog: readonly Skill[] = CURATED_SKILLS) { this.sql.exec(SKILLS_TABLE_SCHEMA); this.ensureDefaults(); }
 private skillFor(name: string): Skill | undefined { return this.catalog.find(s => s.name === name); }
 private createdBy(s: Skill): string { return `${sourceOf(s.name,s.version)}:owner:${this.custodyKey}`; }
 private insert(s: Skill, conflict: string): void {
  this.sql.exec(`INSERT INTO skills(name,version,provenance,identity_locked,provisional,trigger_types_json,trigger_condition,required_tools_json,required_connectors_json,effectiveness,invocations,last_used,body_markdown,created_by,created_at,status,pinned,last_curated_at,archived_at)
   VALUES(?,?,'system',1,0,?,?,?,?,1,0,NULL,?,?,?,'active',1,NULL,NULL) ${conflict}`,s.name,s.version,JSON.stringify(s.trigger_types),s.trigger_condition,JSON.stringify(s.required_tools),JSON.stringify(s.required_connectors),s.body_markdown,this.createdBy(s),s.created_at);
 }
 // Defaults: every reviewed catalog name the owner has no row for (new owners, partial owners, later catalog additions).
 // Upgrade rewrites only an older reviewed row of this owner to the catalog text; status is kept.
 private ensureDefaults(): void {
  // Per-name admission: a reviewed name with no row at all is inserted active. Any existing row
  // (active, archived, hostile) is untouched here, so a disabled skill is never brought back.
  for (const s of this.catalog) if (!this.stored(s.name)) this.insert(s, 'ON CONFLICT(name) DO NOTHING');
  for (const s of this.catalog) {
   const row = this.stored(s.name);
   if (!row || row.admitted !== 1 || row.version === null || row.version >= s.version || row.provenance !== 'system' || row.identity_locked !== 1
    || !row.created_by.startsWith(`reviewed-builtin:${s.name}@`) || !row.created_by.endsWith(`:owner:${this.custodyKey}`)
    || !['[]', JSON.stringify(s.required_tools)].includes(row.required_tools_json) || row.required_connectors_json !== '[]') continue;
   this.sql.exec('UPDATE skills SET version=?,trigger_types_json=?,trigger_condition=?,required_tools_json=?,required_connectors_json=?,body_markdown=?,created_by=?,created_at=? WHERE name=?',
    s.version,JSON.stringify(s.trigger_types),s.trigger_condition,JSON.stringify(s.required_tools),JSON.stringify(s.required_connectors),s.body_markdown,this.createdBy(s),s.created_at,s.name);
  }
 }
 list() { return this.catalog.map(s=>({...metadata(s,this.active(s.name)),description:s.trigger_condition, budget:'conservative_utf8_byte_upper_bound', tools:[...s.required_tools], scripts:false})); }
 install(name:string,version:number,turn:CuratedSkillTurn):Result {
  const s=this.skillFor(name);
  if(!s || !this.authorized(name,version,turn,'install')) return denied();
  const current=this.stored(name);
  if(current && !this.authentic(current,s)) return denied();
  this.insert(s,"ON CONFLICT(name) DO UPDATE SET status='active',archived_at=NULL");
  return {ok:true,source_taint:null,data:metadata(s,true)};
 }
 disable(name:string,version:number,turn:CuratedSkillTurn):Result {
  const s=this.skillFor(name);
  if(!s || !this.authorized(name,version,turn,'disable')) return denied();
  const row=this.stored(name);
  if(row&&!this.authentic(row,s)) return denied();
  this.sql.exec("UPDATE skills SET status='archived' WHERE name=?",name);
  for(const [turnId,selected] of [...this.#selected]) if(selected===name) this.#selected.delete(turnId);
  return {ok:true,source_taint:null,data:metadata(s,false)};
 }
 load(name:string,version:number,turn:CuratedSkillTurn):Result {
  const s=this.skillFor(name);
  if(!s || turn.owner!==this.owner || !turn.turnId || version!==s.version || !s.trigger_types.includes(turn.trigger) || !this.active(name)) return denied();
  const prior=this.#selected.get(turn.turnId);
  if(prior!==undefined && prior!==name) return denied();
  this.#selected.set(turn.turnId,name);
  return {ok:true,source_taint:null,data:metadata(s,true)};
 }
 async prompt(turn:CuratedSkillTurn,canaryTokens:readonly string[]):Promise<string> {
  await turn.assertCurrent();
  const name=this.#selected.get(turn.turnId);
  const s=name===undefined?undefined:this.skillFor(name);
  if(!name || !s || turn.owner!==this.owner || !this.active(name)) return '';
  const before=JSON.stringify(this.stored(name));
  const fragment=renderSkill(s);
  const block=renderBlock([fragment]);
  const fragmentCount=await this.budget.countRenderedSkill(fragment);
  const blockCount=await this.budget.countRenderedBlock(block);
  const limit=s.name===NAME?600:BUNDLED_SKILL_MAX_BYTES;
  if(!fragmentCount.ok || !blockCount.ok || !Number.isSafeInteger(fragmentCount.tokens) || !Number.isSafeInteger(blockCount.tokens)
    || fragmentCount.tokens<0 || blockCount.tokens<0 || fragmentCount.tokens>limit || blockCount.tokens>limit) return '';
  await turn.assertCurrent();
  if(!this.active(name) || JSON.stringify(this.stored(name))!==before || this.#selected.get(turn.turnId)!==name) return '';
  return block;
 }
 private authorized(name:string,version:number,turn:CuratedSkillTurn,action:'install'|'disable') {
  return turn.owner===this.owner && Boolean(turn.turnId) && turn.trigger==='user_message' && version===this.skillFor(name)?.version
   && [ `/skills ${action} ${name}@${version}`, `/skills ${action} ${name}` ].includes(turn.ownerText.trim());
 }
 private stored(name:string):Stored|undefined {
  return this.sql.exec<Stored>(STORED_ROW_QUERY,name).toArray()[0];
 }
 private authentic(row:Stored,s:Skill):boolean {
  return row.admitted===1 && row.version===s.version && row.provenance==='system' && row.identity_locked===1 && row.provisional===0
   && row.trigger_types_json===JSON.stringify(s.trigger_types) && row.trigger_condition===s.trigger_condition
   && row.required_tools_json===JSON.stringify(s.required_tools) && row.required_connectors_json===JSON.stringify(s.required_connectors) && row.body_markdown===s.body_markdown
   && row.created_by===this.createdBy(s) && row.created_at===s.created_at && row.effectiveness===1 && row.pinned===1 && row.invocations===0
   && row.last_used===null && row.last_curated_at===null && row.archived_at===null && ['active','archived'].includes(row.status);
 }
 private active(name:string):boolean {const s=this.skillFor(name); const row=this.stored(name); return s!==undefined && row!==undefined && this.authentic(row,s)&&row.status==='active';}
}
