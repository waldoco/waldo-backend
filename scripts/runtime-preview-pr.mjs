import {pathToFileURL} from 'node:url';import {previewName,resolvePreviewBranch} from './runtime-preview-name.mjs';
export function selectPreviewPr(branch,sha,prs){
 previewName(branch);if(!/^[a-f0-9]{40}$/.test(sha)||!Array.isArray(prs))throw new Error('invalid_preview_head');
 const matches=prs.filter(p=>p.state==='open'&&p.head?.ref===branch&&p.head?.sha===sha&&p.head?.repo?.full_name==='waldoco/waldo-backend'&&p.base?.repo?.full_name==='waldoco/waldo-backend'&&p.base?.ref==='beta-mvp');
 if(matches.length!==1||!Number.isSafeInteger(matches[0].number)||matches[0].number<1)throw new Error('one_verified_open_pr_required');
 return 'pr-v3-'+matches[0].number;
}
export async function resolvePreviewPr(branch,sha,fetcher=fetch){
 const response=await fetcher('https://api.github.com/repos/waldoco/waldo-backend/pulls?state=open&head='+encodeURIComponent('waldoco:'+branch)+'&per_page=100',{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('preview_pr_lookup_failed');const prs=await response.json();if(prs.length>=100)throw new Error('preview_pr_lookup_truncated');return selectPreviewPr(branch,sha,prs);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(process.argv.length!==5)throw new Error('branch_and_head_required');console.log(await resolvePreviewPr(resolvePreviewBranch(process.argv[2],process.argv[3]),process.argv[4]));}
