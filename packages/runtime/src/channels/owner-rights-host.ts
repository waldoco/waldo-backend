import { appPushDirectory } from '../rights/push-directory';
import { appIdentityErasure } from '../rights/identity-erasure';
import { rightsInventory, exportOwnerRuntime, purgeOwnerR2, purgeWorkspaceR2 } from '../rights/custody';
import { buildOwnerRightsExport, saveOwnerRightsExport, readOwnerArtifactBinaries } from '../rights/export';
import { createHealthProduction } from '../health/production';
import { signedRpc } from '../identity/owner-directory';
import { artifactBook, r2ArtifactBodies } from './artifacts';
import { r2ArtifactBinaries } from './artifact-exports';
import { workspaceOwnerHost, type WorkspaceEnv } from './workspace-host';
import { sha256Hex } from '../connectors/google';
import type { AppRightsHost } from './app-rights';
import { ownerByteCustody } from '../rights/write-custody';

// The authenticated owner host supplies current admission for exports and an
// immediate run fence for deletion. Cleanup authority comes from the previously
// reviewed one-shot capability, never an ambient session retained for polling.
export const createOwnerRightsHost = (deps: {
  env: WorkspaceEnv & { RESPONSIBILITY_RATE_LIMITER?: RateLimit };
  storage: DurableObjectStorage; doName: string; doId: string; sessionHash: string;
  assertCurrent(): Promise<void>; lock(receiptId:string): Promise<void>;
  // Host may wait for currently running invocations; durable byte reservations
  // below still prevent false erasure after an interrupted/uncertain provider put.
  quiesce?(): Promise<void>;
  productState(): Promise<object>; directoryMetadata(): Promise<object>;
}): AppRightsHost => {
  const {env,storage,doName,doId,sessionHash}=deps;
  const physical = () => { if(storage.kv.get<string>('do_name')!==doName || env.TELEGRAM_OWNER_DO?.idFromName(doName).toString()!==doId)throw new Error('rights_owner_changed'); };
  const push=appPushDirectory(env,doName,sessionHash);
  const bytes=ownerByteCustody(storage,deps.assertCurrent);
  const openWorkspace=()=>workspaceOwnerHost(env,storage,doId,doName,fetch,undefined,deps.assertCurrent,bytes);
  const artifactStore=()=>{if(!env.ARTIFACTS)throw new Error('rights_storage_unavailable');return artifactBook(storage.sql,r2ArtifactBodies(env.ARTIFACTS,doId,bytes),{timezone:'UTC',now:()=>new Date()},()=>crypto.randomUUID());};
  return {
    owner:doName,session:sessionHash,storage,secret:env.WALDO_ROUTER_HMAC_SECRET??'',now:Date.now,
    push,assertCurrent:deps.assertCurrent,inventory:rightsInventory,
    rateLimit:async()=>{physical();return Boolean(env.RESPONSIBILITY_RATE_LIMITER&&(await env.RESPONSIBILITY_RATE_LIMITER.limit({key:`app-rights:${doName}`})).success);},
    buildExport:async()=>buildOwnerRightsExport({accountRef:`acct_${await sha256Hex(doName.trim().toUpperCase())}`,now:Date.now,assertCurrent:deps.assertCurrent,inventory:await rightsInventory(),productState:async()=>({tables:exportOwnerRuntime(storage.sql),...await deps.productState()}),directoryMetadata:deps.directoryMetadata,openWorkspace,artifacts:artifactStore(),binaryArtifacts:async()=>readOwnerArtifactBinaries(storage.sql,r2ArtifactBinaries(env.ARTIFACTS!,doId,bytes))}),
    saveExport:async(id,bytes)=>saveOwnerRightsExport(await openWorkspace(),id,bytes),
    lockOwner:async id=>{
      physical();
      storage.transactionSync(()=>{const prior=storage.kv.get<string>('rights:owner-lock');if(prior&&prior!==id)throw new Error('rights_conflict');storage.kv.put('rights:owner-lock',id);});
      await deps.lock(id);physical();
    },
    deleteStore:async(store,receiptId)=>{
      physical();if(storage.kv.get('rights:owner-lock')!==receiptId)throw new Error('rights_not_locked');
      if(store==='push_devices'){await push.revokeAll();return 'completed';}
      if(store==='health_plane'){const result=await createHealthProduction(signedRpc(env),doName).purge();if(!result.ok)throw new Error('rights_health_unconfirmed');return 'completed';}
      if(['workspace','artifacts','owner_runtime','auth_identity','directory'].includes(store)){await deps.quiesce?.();await bytes.quiesce();physical();bytes.assertQuiescent();}
      if(store==='workspace'){
        if(!env.ARTIFACTS||!env.WALDO_ENVIRONMENT||!env.WALDO_OWNER_DO_NAMESPACE)throw new Error('rights_storage_unavailable');
        const call=signedRpc(env);if(!call)throw new Error('rights_mapping_unavailable');
        const locator=JSON.stringify([env.WALDO_ENVIRONMENT,env.WALDO_OWNER_DO_NAMESPACE,doName,doId]);
        const raw=await call('workspace_owner_binding',`workspace.bind.${await sha256Hex(locator)}`,{p_environment:env.WALDO_ENVIRONMENT,p_namespace:env.WALDO_OWNER_DO_NAMESPACE,p_do_name:doName,p_do_id:doId,p_locator:locator}) as {owner_id?:string;environment?:string;namespace?:string;do_name?:string;do_id?:string}|null;
        physical();if(!raw?.owner_id||raw.environment!==env.WALDO_ENVIRONMENT||raw.namespace!==env.WALDO_OWNER_DO_NAMESPACE||raw.do_name!==doName||raw.do_id!==doId)throw new Error('rights_mapping_unavailable');
        await purgeWorkspaceR2(env.ARTIFACTS,{ownerId:raw.owner_id,environment:raw.environment,namespace:raw.namespace,doName:raw.do_name,doId:raw.do_id},{doName,doId});return 'completed';
      }
      if(store==='artifacts'){if(!env.ARTIFACTS)throw new Error('rights_storage_unavailable');await purgeOwnerR2(env.ARTIFACTS,doId);return 'completed';}
      if(store==='owner_runtime'){
        storage.transactionSync(()=>{
          // Drop every product virtual table before enumerating its shadow tables.
          const virtual=storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '__cf_%'").toArray();
          for(const {name} of virtual){if(!/^[A-Za-z0-9_]+$/.test(name))throw new Error('rights_table_unavailable');storage.sql.exec(`DROP TABLE "${name}"`);}
          const remaining=storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '__cf_%'").toArray();
          for(const {name} of remaining){if(!/^[A-Za-z0-9_]+$/.test(name))throw new Error('rights_table_unavailable');storage.sql.exec(`DROP TABLE "${name}"`);}
          for(const [name] of storage.kv.list())if(name!=='do_name'&&name!=='rights:owner-lock'&&!name.startsWith('rights.job.')&&!name.startsWith('rights.operation.'))storage.kv.delete(name);
        });return 'completed';
      }
      if(store==='auth_identity'||store==='directory'){await appIdentityErasure(env,doName).erase(receiptId);return 'completed';}
      if(store==='audit')return 'retained';
      return 'outside_control';
    },
  };
};
