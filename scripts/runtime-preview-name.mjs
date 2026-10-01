import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export function previewName(branch) {
 if(typeof branch!=='string'||branch.length<1||branch.length>255||/[\x00-\x20\x7f]/.test(branch)||['HEAD','main','beta-mvp','production','staging','greenfield/harness-foundation'].includes(branch))throw new Error('preview_requires_feature_branch');
 return 'pr-v2-'+createHash('sha256').update(branch,'utf8').digest('hex').slice(0,24);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){if(process.argv.length!==3)throw new Error('one_branch_required');console.log(previewName(process.argv[2]));}
