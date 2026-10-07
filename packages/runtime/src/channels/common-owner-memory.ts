import type {ClaimStore} from '../memory/claims';
// Private host projection of the existing physical owner's store. Caller owns
// identity/source/egress admission; this read never creates authority or a writer.
export const commonOwnerMemory=(store:ClaimStore):Pick<ClaimStore,'recall'>=>({
 recall:(query,limit)=>{
  if(store.incompleteTopics().length)throw Error('Owner memory forgetting coverage incomplete');
  const rows=store.recall(query,limit).filter(row=>row.origin==='owner'&&row.kind!=='health'
    && ['active','promoted'].includes(row.status)&&!row.valid_to
    && typeof row.source_ref==='string'&&row.source_ref.length>0&&row.verification_status==='owner-grounded'
    &&(!row.valid_from||(Number.isFinite(Date.parse(row.valid_from))&&Date.parse(row.valid_from)<=Date.now())));
  if(store.incompleteTopics().length)throw Error('Owner memory forgetting coverage changed');
  return rows;
 },
});
