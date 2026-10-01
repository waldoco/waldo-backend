import {previewName} from './runtime-preview-name.mjs';
export function retirementNames(event,pr,inventory){
 if(event.action!=='closed'||event.repository?.full_name!=='waldoco/waldo-backend'||event.pull_request?.number!==pr.number||pr.state!=='closed'||pr.base?.repo?.full_name!=='waldoco/waldo-backend'||pr.head?.repo?.full_name!=='waldoco/waldo-backend'||pr.head.sha!==event.pull_request.head.sha||pr.head.ref!==event.pull_request.head.ref||!/^[a-f0-9]{40}$/.test(pr.head.sha))throw new Error('retirement_identity_not_verified');
 const allowed=new Set([previewName(pr.head.ref),'isolated-'+pr.head.sha]);
 return inventory.filter(x=>allowed.has(x.name)).map(x=>x.name);
}
