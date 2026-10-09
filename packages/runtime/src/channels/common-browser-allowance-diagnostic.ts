import { browserSessionSchema } from '@waldo/contracts';
import { commonSpendReservation } from './common-spend-reservation';
import { assertCommonPublicBrowserUsage } from './common-public-browser-configuration';
import { COMMON_BROWSER_MONTH_CEILING_MICROUSD, commonStagingRegistration } from './common-staging-registration';
import { cloudflareBrowserProviderReadiness } from './browser-public-read-configuration';
import type { TelegramWebhookEnv } from './telegram-webhook';

type Status = 'registered' | 'expired' | 'conflict' | 'exhausted' | 'unregistered' | 'unverifiable';
// Numbers describe retained reservations, never vendor reconciliation or approval.
export function commonBrowserAllowanceDiagnostic(options: Readonly<{
 env: TelegramWebhookEnv; storage: DurableObjectStorage; actualDoId: string; now: number;
 owner: Readonly<{directoryOwnerId: string; custodyDigest: string; doName: string; subject: string}>;
}>) {
 const { env, storage, owner, now } = options;
 const result = {
  status: 'unverifiable' as Status, providerReady: false,
  registeredCapMicrousd: null as number | null,
  retainedReservedMicrousd: null as number | null,
  aggregateRetainedReservedMicrousd: null as number | null,
  remainingCurrentPolicyMicrousd: null as number | null,
  remainingRegisteredCapAfterAllRetainedRefsMicrousd: null as number | null,
  retainedCallCount: null as number | null, remainingRegisteredCallSlots: null as number | null,
  retainedAllocations: null as number | null, remainingRegisteredAllocations: null as number | null,
  retainedReservedBrowserMs: null as number | null, remainingRegisteredBrowserMs: null as number | null,
  currentMonthReservedMicrousd: null as number | null,
  retainedSessionCounts: null as {active:number;unresolved:number;pendingCleanup:number;failedCleanup:number;closed:number} | null,
  retainedTestGate: null as {remainingRuns:number;remainingModelCalls:number;registeredPriorMicrousd:number} | null,
  externalPriorUse: 'unknown' as const,
 };
 try {
  if(env.WALDO_ENVIRONMENT !== 'staging' || storage.kv.get('do_name') !== owner.doName
   || storage.kv.get('telegram_subject') !== owner.subject || storage.kv.get('telegram_unlinked') === true
   || env.TELEGRAM_OWNER_DO?.idFromName(owner.doName).toString() !== options.actualDoId) return result;
  result.providerReady = cloudflareBrowserProviderReadiness(env);
  const ownerId = `prn_${owner.directoryOwnerId.toLowerCase().replaceAll('-', '')}`;
  const ledgers = [...storage.kv.list<any>({prefix:'common-spend:'})];
  let aggregate = 0;
  for(const [key,row] of ledgers) {
   if(!row?.policy || row.policy.ownerId !== ownerId || key !== `common-spend:${row.policy.ref}`) throw Error('conflicting retained spend');
   aggregate += commonSpendReservation(storage,row.policy,()=>now,()=>{}).reserved();
   if(!Number.isSafeInteger(aggregate)) throw Error('conflicting retained total');
  }
  if(ledgers.length) result.aggregateRetainedReservedMicrousd = aggregate;
  for(const [,total] of storage.kv.list<number>({prefix:'common-public-browser-month:'})) {
   if(!Number.isSafeInteger(total) || total < 0 || total > COMMON_BROWSER_MONTH_CEILING_MICROUSD) throw Error('conflicting month');
  }
  const month = storage.kv.get<number>(`common-public-browser-month:${new Date(now).toISOString().slice(0,7)}`);
  result.currentMonthReservedMicrousd = month ?? null;
  const sessions = {active:0,unresolved:0,pendingCleanup:0,failedCleanup:0,closed:0};
  for(const [,row] of storage.kv.list<any>({prefix:'common-browser:'})) {
   const session=browserSessionSchema.parse(row?.session);
   if(session.ownerId !== ownerId || row?.grant?.ownerId !== ownerId
    || session.provider !== 'cloudflare_playwright' || session.mode !== 'public'
    || row.cleanup !== undefined && !['pending','closed'].includes(row.cleanup)) throw Error('conflicting retained session');
   if(row.cleanup === 'closed') { if(row.session.state !== 'ended') throw Error('conflicting closed session'); sessions.closed++; }
   else if(row.cleanupFailed) sessions.failedCleanup++;
   else if(row.cleanup === 'pending') sessions.pendingCleanup++;
   else if(['starting','active'].includes(session.state)) sessions.active++;
   else sessions.unresolved++;
  }
  result.retainedSessionCounts = sessions;
  if(!env.COMMON_BROWSER_REGISTRATION) { result.status='unregistered'; return result; }
  const raw=JSON.parse(env.COMMON_BROWSER_REGISTRATION);
  const pinned=storage.kv.get<any>('common_owner_browser_registration_v1');
  let descriptor=raw;
  if(raw?.scope === 'verified_owners') {
   if(!raw.policy?.ref || raw.policy.doName !== undefined || raw.policy.subject !== undefined || raw.policy.directoryOwnerId !== undefined) throw Error('conflicting operator policy');
   const selected = raw.acceptance?.doName === owner.doName && raw.acceptance?.subject === owner.subject;
   if(selected && raw.acceptance.directoryOwnerId !== owner.directoryOwnerId) throw Error('conflicting acceptance owner');
   descriptor={...(selected?{acceptance:raw.acceptance}:{}),policy:{...raw.policy,doName:owner.doName,subject:owner.subject,directoryOwnerId:owner.directoryOwnerId,ref:`${raw.policy.ref}:owner:${owner.directoryOwnerId}`},spend:raw.spend,billing:raw.billing};
   if(pinned && (pinned.custodyDigest !== owner.custodyDigest || pinned.operator !== JSON.stringify(raw)
    || JSON.stringify(pinned.registration) !== JSON.stringify(descriptor))) throw Error('conflicting automatic pin');
  } else if(pinned) throw Error('conflicting registration selection');
  const registered=commonStagingRegistration({WALDO_ENVIRONMENT:'staging',COMMON_BROWSER_REGISTRATION:JSON.stringify(descriptor)});
  if(!registered || registered.policy.doName !== owner.doName || registered.policy.subject !== owner.subject
   || registered.policy.directoryOwnerId !== owner.directoryOwnerId) throw Error('conflicting registration owner');
  const {policy,spend}=registered;
  // Retained test custody still blocks serving after ref rotation or capsule
  // removal; a read-only diagnostic must not report that history as available.
  for(const prefix of ['common-browser-acceptance:','common-browser-acceptance-custody:']) {
   const expected=prefix+(prefix.endsWith('custody:')?policy.ref:spend.policy.ref);
   if([...storage.kv.list({prefix})].some(([key])=>key!==expected)) throw Error('conflicting acceptance ref');
  }
  const testCustody=storage.kv.get<string>(`common-browser-acceptance-custody:${policy.ref}`);
  if(testCustody !== undefined && (!spend.acceptance || testCustody !== owner.custodyDigest)) throw Error('conflicting acceptance custody');
  result.registeredCapMicrousd=spend.policy.limitMicrousd;
  const ledger=storage.kv.get<any>(`common-spend:${policy.ref}`);
  if(ledger) {
   const retained=commonSpendReservation(storage,spend.policy,()=>now,()=>{},spend.acceptance);
   const reserved=retained.reserved(), gate=retained.acceptanceRemaining();
   if(gate) result.retainedTestGate={remainingRuns:gate.remainingRuns,remainingModelCalls:gate.remainingModelCalls,registeredPriorMicrousd:gate.priorMicrousd};
   result.retainedReservedMicrousd=reserved;
   result.remainingCurrentPolicyMicrousd=Math.max(0,spend.policy.limitMicrousd-reserved-(gate?.priorMicrousd??0));
   result.remainingRegisteredCapAfterAllRetainedRefsMicrousd=Math.max(0,spend.policy.limitMicrousd-aggregate-(gate?.priorMicrousd??0));
   result.retainedCallCount=ledger.calls.length;
   result.remainingRegisteredCallSlots=spend.policy.maxCalls-ledger.calls.length-ledger.cleanup.reduce((sum:number,item:any)=>sum+item.maxCalls,0);
  }
  const usage=storage.kv.get<any>(`common-public-browser-usage:${policy.ref}`);
  if(usage) {
   assertCommonPublicBrowserUsage(usage,policy,spend.allocationMicrousd);
   if(usage.custodyDigest !== owner.custodyDigest) throw Error('conflicting usage custody');
   result.retainedAllocations=usage.allocations;
   result.remainingRegisteredAllocations=policy.maxAllocations-usage.allocations;
   result.retainedReservedBrowserMs=usage.reservedBrowserMs;
   result.remainingRegisteredBrowserMs=policy.maxReservedBrowserMs-usage.reservedBrowserMs;
  }
  result.status=now < policy.createdAt || now >= policy.expiresAt || now >= spend.policy.validUntil
   || spend.acceptance && now >= spend.acceptance.expiresAt ? 'expired'
   : result.remainingCurrentPolicyMicrousd === 0 || result.remainingRegisteredCapAfterAllRetainedRefsMicrousd === 0
   || result.retainedTestGate?.remainingRuns === 0 || result.retainedTestGate?.remainingModelCalls === 0
   || result.remainingRegisteredCallSlots === 0 || result.remainingRegisteredAllocations === 0
   || result.remainingRegisteredBrowserMs !== null && result.remainingRegisteredBrowserMs < policy.lifetimeMs*2 ? 'exhausted'
   : !result.providerReady || !ledger || !usage ? 'unverifiable' : 'registered';
  return result;
 } catch {
  // Invalid history cannot produce a plausible remaining allowance.
  return {...result,status:'conflict' as Status,retainedReservedMicrousd:null,aggregateRetainedReservedMicrousd:null,
   remainingCurrentPolicyMicrousd:null,remainingRegisteredCapAfterAllRetainedRefsMicrousd:null,
   retainedCallCount:null,remainingRegisteredCallSlots:null,retainedAllocations:null,remainingRegisteredAllocations:null,
   retainedReservedBrowserMs:null,remainingRegisteredBrowserMs:null,currentMonthReservedMicrousd:null,retainedSessionCounts:null,retainedTestGate:null};
 }
}
