import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export function resolvePreviewBranch(local,ci){
 if(local && ci && local!==ci)throw new Error('preview_branch_mismatch');
 const branch=local||ci;previewName(branch);return branch;
}
export function previewName(branch) {
 if(typeof branch!=='string'||branch.length<1||branch.length>255||branch.startsWith('refs/')||branch.startsWith('-')||branch.startsWith('/')||branch.endsWith('/')||branch.endsWith('.')||branch.includes('..')||branch.includes('@{')||branch.includes('//')||branch==='@'||branch.split('/').some(x=>x.startsWith('.')||x.endsWith('.lock'))||/[\x00-\x20\x7f~^:?*\[\\]/.test(branch)||['HEAD','main','beta-mvp','production','staging','greenfield/harness-foundation'].includes(branch))throw new Error('preview_requires_feature_branch');
 return 'pr-v2-'+createHash('sha256').update(branch,'utf8').digest('hex').slice(0,24);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){if(process.argv.length!==4)throw new Error('local_and_ci_branch_required');console.log(previewName(resolvePreviewBranch(process.argv[2],process.argv[3])));}
