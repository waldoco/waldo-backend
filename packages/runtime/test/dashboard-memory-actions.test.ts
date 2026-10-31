import {describe,it,expect} from 'vitest';
import {projectMemoryControl,memoryControl,resolveMemoryAction} from '../src/channels/dashboard-memory-actions';
import {controlRevision} from '../src/channels/dashboard-control-actions';
import {SAMPLE_CONSOLE_VIEW} from './fixtures/console-sample';
describe('owner Memory action resolution',()=>{
 it('reads a node as confirmed only on the owner\'s yes to its wording, and one with a support no longer live as Waldo\'s read with no confirm that would fail',()=>{
  const node=SAMPLE_CONSOLE_VIEW.nodes.find(n=>n.id===1)!,ids=JSON.parse(node.supporting_spots) as number[];
  const ground=(c:typeof SAMPLE_CONSOLE_VIEW.spots[number])=>ids.includes(c.id)?{...c,origin:'owner',verification_status:'owner-grounded'}:c;
  const grounded={...SAMPLE_CONSOLE_VIEW,spots:SAMPLE_CONSOLE_VIEW.spots.map(ground),retiredSpots:SAMPLE_CONSOLE_VIEW.retiredSpots.map(ground)};
  expect(memoryControl(grounded,'owner','owner:node:1')).toMatchObject({review:{confirmation:'waldos_read'},actions:['node.confirm','node.correct','node.forget']});
  const yes={...grounded.spots[0]!,id:900,kind:'node_statement',text:`${node.label}: ${node.summary}`,source_ref:'node:1:app:node.confirm',status:'active'};
  const confirmed={...grounded,statements:[yes],nodes:grounded.nodes.map(n=>n.id===1?{...n,supporting_spots:JSON.stringify([...ids,900])}:n)};
  expect(memoryControl(confirmed,'owner','owner:node:1')).toMatchObject({review:{confirmation:'confirmed'},actions:['node.correct','node.forget']});
  const gap={...confirmed,nodes:confirmed.nodes.map(n=>n.id===1?{...n,supporting_spots:JSON.stringify([...ids,900,999])}:n)};
  expect(memoryControl(gap,'owner','owner:node:1')).toMatchObject({review:{confirmation:'waldos_read'},actions:['node.correct','node.forget']});
 });
 it('requires an exact owner-scoped authoritative target, never numeric or foreign-owner IDs',()=>{for(const id of ['5','other:claim:5','owner:claim:999','owner:node:5'])expect(resolveMemoryAction(SAMPLE_CONSOLE_VIEW,'owner',{action:'spot.confirm',id,value:''})).toBeNull();expect(resolveMemoryAction(SAMPLE_CONSOLE_VIEW,'owner',{action:'spot.confirm',id:'owner:claim:5',value:''})?.id).toBe('5');});
 it('preserves confirm only for inferred active Spots and incomplete forget retry only',()=>{expect(memoryControl(SAMPLE_CONSOLE_VIEW,'owner','owner:claim:4')?.actions).not.toContain('spot.confirm');expect(memoryControl(SAMPLE_CONSOLE_VIEW,'owner','owner:claim:7')?.actions).toEqual(['spot.forget']);expect(resolveMemoryAction(SAMPLE_CONSOLE_VIEW,'owner',{action:'spot.dismiss',id:'owner:claim:7',value:''})).toBeNull();});
 it('does not expose withheld text or source pointers from retry control reads',()=>{const read=JSON.stringify(memoryControl(SAMPLE_CONSOLE_VIEW,'owner','owner:claim:7'));expect(read).not.toContain('phone');expect(read).not.toContain('evidence');expect(read).not.toContain('source_ref');expect(read).toContain('purging');});
 it('keeps pattern forget separate from its supporting Spot actions',()=>{expect(memoryControl(SAMPLE_CONSOLE_VIEW,'owner','owner:node:1')?.actions).toEqual(['node.confirm','node.correct','node.forget']);expect(resolveMemoryAction(SAMPLE_CONSOLE_VIEW,'owner',{action:'spot.forget',id:'owner:node:1',value:''})).toBeNull();});
 it('changes the action revision when same-ID reviewed content changes',async()=>{const before=projectMemoryControl(SAMPLE_CONSOLE_VIEW,'owner','owner:claim:5');const changed={...SAMPLE_CONSOLE_VIEW,spots:SAMPLE_CONSOLE_VIEW.spots.map(c=>c.id===5?{...c,text:'Corrected saved preference'}:c)};expect(await controlRevision(projectMemoryControl(changed,'owner','owner:claim:5'))).not.toBe(await controlRevision(before));});
});
