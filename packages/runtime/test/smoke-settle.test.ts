import { it, expect } from 'vitest';
import { settleSmokeOwner } from '../scenarios/smoke-settle';
it('rechecks queue work created while transport completes without sleeps',async()=>{
 const owner={queue:Promise.resolve()};let calls=0;let completed=false;
 await settleSmokeOwner(owner,{pending:()=>0,settle:async()=>{calls++;if(calls===1)owner.queue=Promise.resolve().then(()=>{completed=true;});}});
 expect(calls).toBe(2);expect(completed).toBe(true);
});
it('waits for the existing queue before transport and returns only after completion',async()=>{
 let release!:()=>void;const owner={queue:new Promise<void>(resolve=>{release=resolve;})};let drained=false;
 const work=settleSmokeOwner(owner,{pending:()=>0,settle:async()=>{drained=true;}});
 await Promise.resolve();expect(drained).toBe(false);release();await work;expect(drained).toBe(true);
});
