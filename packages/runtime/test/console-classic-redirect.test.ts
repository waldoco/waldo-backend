import {describe,it,expect} from 'vitest';
import {classicConsoleRedirect,CONSOLE_PAGES} from '../src/channels/console';

const origin='https://waldo.test';
const open=(path:string,init:RequestInit={})=>classicConsoleRedirect(new Request(origin+path,init));
const location=(path:string)=>open(path)?.headers.get('location')??null;

describe('classic console pages open the new console',()=>{
 it('sends every classic page to its new-console route',()=>{
  expect(Object.fromEntries(CONSOLE_PAGES.filter(page=>page.slug).map(page=>[page.slug,location('/console/'+page.slug)]))).toEqual({
   waiting:'/console#/waiting',setup:'/console#/setup',connections:'/console#/connections',spots:'/console#/memory/spots',
   constellation:'/console#/memory/constellation',day:'/console#/day',memory:'/console#/memory',files:'/console#/files',
   usage:'/console#/usage',activity:'/console#/patrol',account:'/console#/account',
  });
  expect(location('/console/legacy')).toBe('/console');
  expect(location('/console/invites')).toBe('/console#/invites');
  expect(location('/console/admin')).toBe('/console#/admin');
  expect(location('/console/imessage')).toBe('/console#/connections/imessage');
  expect(location('/console/devices')).toBe('/console#/connections/devices');
  expect(open('/console/waiting')?.status).toBe(303);
 });
 it('drops a notice instead of showing URL text on the console',()=>{
  expect(location('/console?m=invalid')).toBe('/console');
  expect(location('/console?m='+encodeURIComponent('Your account is locked. Call +1 555 0100.'))).toBe('/console');
  expect(location('/console/waiting?m=invalid')).toBe('/console#/waiting');
 });
 it('leaves JSON reads, form posts, sign-in links and the plain root alone',()=>{
  expect(open('/console/waiting',{headers:{accept:'application/json'}})).toBeNull();
  expect(open('/console/admin',{headers:{accept:'application/json'}})).toBeNull();
  expect(open('/console/action',{method:'POST'})).toBeNull();
  expect(open('/console/waiting',{method:'POST'})).toBeNull();
  expect(open('/console/devices',{method:'POST'})).toBeNull();
  for(const path of ['/console','/console?t=ticket','/console/signin','/console/file?id=1','/console/workspace','/console/unknown','/console/constructor','/console/__proto__'])expect(open(path)).toBeNull();
 });
});
