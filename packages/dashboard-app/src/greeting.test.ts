import {it,expect} from 'vitest';
import {greeting} from './greeting';
it('uses the current clock in the recorded timezone, not snapshot time or device zone',()=>{
 expect(greeting('Asia/Kolkata',new Date('2026-10-03T02:00:00Z'))).toBe('Good morning.');
 expect(greeting('Asia/Kolkata',new Date('2026-10-03T08:00:00Z'))).toBe('Good afternoon.');
 expect(greeting('Asia/Kolkata',new Date('2026-10-03T17:00:00Z'))).toBe('Good evening.');
 expect(greeting('America/Los_Angeles',new Date('2026-10-03T17:00:00Z'))).toBe('Good morning.');
 expect(greeting('invalid',new Date())).toBe('Hello.');
});


it('uses a neutral overnight greeting and changes at the local morning boundary',()=>{
 expect(greeting('Asia/Kolkata',new Date('2026-10-03T18:30:00Z'))).toBe('Hello.');
 expect(greeting('Asia/Kolkata',new Date('2026-10-03T23:29:00Z'))).toBe('Hello.');
 expect(greeting('Asia/Kolkata',new Date('2026-10-03T23:30:00Z'))).toBe('Good morning.');
});

