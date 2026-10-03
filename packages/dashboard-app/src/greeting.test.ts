import {it,expect} from 'vitest';
import {greeting,homeBrief} from './greeting';
import type {OverviewV1} from './model';
const empty:OverviewV1={version:1,as_of:'2026-10-03T00:00:00Z',timezone:'Asia/Kolkata',waiting:{count:0,first:null},brief:{status:'not_sent',at:null},next_card:null,latest_activity:null,services:[]};
it('uses the current clock in the recorded timezone, not snapshot time or device zone',()=>{
 expect(greeting('Asia/Kolkata',new Date('2026-10-03T02:00:00Z'))).toBe('Good morning.');
 expect(greeting('Asia/Kolkata',new Date('2026-10-03T08:00:00Z'))).toBe('Good afternoon.');
 expect(greeting('Asia/Kolkata',new Date('2026-10-03T17:00:00Z'))).toBe('Good evening.');
 expect(greeting('America/Los_Angeles',new Date('2026-10-03T17:00:00Z'))).toBe('Good morning.');
 expect(greeting('invalid',new Date())).toBe('Hello.');
});
it('briefs only recorded counts and schedules without inventing a result',()=>{
 expect(homeBrief(empty)).toBe('No decisions are waiting. No next card is recorded.');
 expect(homeBrief({...empty,waiting:{count:2,first:null},next_card:{id:'c',label:'Check-in',scheduled_at:'2026-10-03T18:00:00Z'}})).toBe('2 decisions are waiting for you. Check-in is next on your recorded plan.');
 expect(homeBrief({...empty,brief:{status:'sent_recorded',at:empty.as_of}})).not.toMatch(/delivered|completed|all caught up/);
});
