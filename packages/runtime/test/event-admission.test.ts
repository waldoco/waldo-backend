import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {eventAdmission} from '../src/channels/event-admission';
it('durable event admission survives reconstruction, binds raw digest and never reclaims unknown notifications',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('event-admission-custody'));
 await runInDurableObject(stub,async(_instance,state)=>{
  const inbox=eventAdmission(state.storage);
  expect(inbox.admit('github','id:one','a','fixture')).toBe('admitted');
  // Crash after admission: same delivery can claim the retained work exactly once.
  const restarted=eventAdmission(state.storage);expect(restarted.admit('github','id:one','a','fixture')).toBe('duplicate');expect(restarted.claim('github','id:one')).toBe(true);
  // Crash after claim: whether the external send happened is unknown. No blind retry.
  const lost=eventAdmission(state.storage);expect(lost.claim('github','id:one')).toBe(false);expect(lost.admit('github','id:one','b','changed')).toBe('conflict');
  expect(lost.admit('other','id:one','b','fixture')).toBe('admitted');expect(lost.claim('other','id:one')).toBe(true);lost.finish('other','id:one');expect(lost.claim('other','id:one')).toBe(false);
  expect(state.storage.sql.exec<{state:string}>("SELECT state FROM event_admissions WHERE source='github'").one().state).toBe('unknown');
 });
});
