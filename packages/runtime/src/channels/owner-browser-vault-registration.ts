import { browserStateVault } from '../connectors/browser-state-vault';
import { signedRpc, hex } from '../identity/owner-directory';
import type { TelegramWebhookEnv } from './telegram-webhook';
import type { BrowserStateBinding, BrowserVaultScope } from './browser-state-custody';
import type { PrivateBrowserRegistration } from './owner-private-browser-host';
import { PRIVATE_BROWSER_CONSENT_KEY, type PrivateBrowserConsent } from './browser-private-consent';
type Options=Readonly<{env:TelegramWebhookEnv;storage:DurableObjectStorage;actualDoId:string;fetcher?:typeof fetch;assertOwner():Promise<Readonly<{directoryOwnerId:string;custodyDigest:string}>>}>;
type Reference=Readonly<{doName:string;scope:BrowserVaultScope}>;
export const browserVaultReferenceKey=(b:BrowserStateBinding)=>`private-browser-vault-reference/v1/${JSON.stringify([b.ownerId,b.environment,b.siteOrigin,b.accountId,b.generation])}`;
export function ownerBrowserVaultRegistration(options:Options&Readonly<{registration:Omit<PrivateBrowserRegistration,'custody'>}>):PrivateBrowserRegistration{
 const policy={...options.registration,sitePolicy:{origins:[...options.registration.sitePolicy.origins],cookieDomains:[...options.registration.sitePolicy.cookieDomains]}};
 return {...policy,custody:async(binding,_blobs,admit)=>{
  const check=async()=>{if(await admit(binding)!==true)throw Error('browser_state_unavailable');};await check();
  const approval=options.storage.kv.get<PrivateBrowserConsent>(PRIVATE_BROWSER_CONSENT_KEY),doName=options.storage.kv.get<string>('do_name'),subject=options.storage.kv.get<string>('telegram_subject'),namespace=options.env.WALDO_OWNER_DO_NAMESPACE;
  if(!approval||approval.state!=='approved'||JSON.stringify(approval.binding)!==JSON.stringify(binding)||!doName||!subject||!namespace||options.env.WALDO_ENVIRONMENT!=='staging'||options.env.TELEGRAM_OWNER_DO?.idFromName(doName).toString()!==options.actualDoId)throw Error('browser_state_unavailable');
  const assertCurrent=async()=>{await check();const current=await options.assertOwner();if(current.directoryOwnerId!==binding.ownerId||current.custodyDigest!==approval.custodyDigest||JSON.stringify(options.storage.kv.get(PRIVATE_BROWSER_CONSENT_KEY))!==JSON.stringify(approval))throw Error('browser_state_unavailable');};
  await assertCurrent();
  // Reuse canonical owner/namespace provisioning, not a new state authority or storage substrate.
  const rpc=signedRpc(options.env,options.fetcher),locator=JSON.stringify([binding.environment,namespace,doName,options.actualDoId]);
  if(!rpc)throw Error('browser_state_unavailable');
  const map=await rpc('workspace_owner_binding',`workspace.bind.${hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(locator)))}`,{p_environment:binding.environment,p_namespace:namespace,p_do_name:doName,p_do_id:options.actualDoId,p_locator:locator}) as Record<string,unknown>|null;
  await assertCurrent();if(!map||map.owner_id!==binding.ownerId||map.environment!==binding.environment||map.namespace!==namespace||map.do_name!==doName||map.do_id!==options.actualDoId)throw Error('browser_state_unavailable');
  const reference:Reference={doName,scope:{binding:{...binding},consentRevision:approval.revision,custodyDigest:approval.custodyDigest,expiresAt:approval.expiresAt,namespace,doId:options.actualDoId,subject,sitePolicy:policy.sitePolicy}};
  options.storage.transactionSync(()=>{if(JSON.stringify(options.storage.kv.get(PRIVATE_BROWSER_CONSENT_KEY))!==JSON.stringify(approval))throw Error('browser_state_unavailable');const retained=options.storage.kv.get<Reference>(browserVaultReferenceKey(binding));if(retained&&JSON.stringify(retained)!==JSON.stringify(reference))throw Error('browser_state_unavailable');options.storage.kv.put(browserVaultReferenceKey(binding),reference);});
  return browserStateVault({env:options.env,doName,scope:reference.scope,fetcher:options.fetcher,assertCurrent});
 }};
}
// Retirement uses retained identity, never a new persistence grant or a decrypt operation.
// It remains available when the private registration/consent expires or Telegram is unlinked.
export async function revokeOwnerBrowserVault(options:Options,approval:PrivateBrowserConsent):Promise<void>{
 const key=browserVaultReferenceKey(approval.binding),reference=options.storage.kv.get<Reference>(key);if(!reference)return;
 const physical=async()=>{if(options.env.WALDO_ENVIRONMENT!=='staging'||reference.scope.namespace!==options.env.WALDO_OWNER_DO_NAMESPACE||reference.scope.doId!==options.actualDoId||options.storage.kv.get('do_name')!==reference.doName||options.env.TELEGRAM_OWNER_DO?.idFromName(reference.doName).toString()!==options.actualDoId||JSON.stringify(options.storage.kv.get(key))!==JSON.stringify(reference))throw Error('browser_state_unavailable');};
 await physical();await browserStateVault({env:options.env,doName:reference.doName,scope:reference.scope,fetcher:options.fetcher,assertCurrent:physical}).revoke();
 options.storage.transactionSync(()=>{if(JSON.stringify(options.storage.kv.get(key))!==JSON.stringify(reference))throw Error('browser_state_unavailable');options.storage.kv.delete(key);});
}
