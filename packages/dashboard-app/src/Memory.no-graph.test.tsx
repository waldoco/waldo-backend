import {afterEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryList,MemoryPanel} from './Memory';
import {readMemory,type MemoryPage} from './memory-model';
import {response} from './memory-test-fixtures';
import {parseMemoryDestination} from './destinations';
import {resolveRoute} from './App';

afterEach(()=>vi.unstubAllGlobals());
// The constellation is retired: Memory shows Spots and the profile, as a list or calendar, with no graph and no patterns.
describe('Memory without the constellation',()=>{
 it('lists Spots with List and Calendar views only, opening on the list',()=>{
  const html=renderToStaticMarkup(<MemoryList data={readMemory(response('view=claims&limit=25')) as MemoryPage} onNext={()=>{}} onRestart={()=>{}}/>);
  expect(html).toContain('memory-record-list');
  expect(html).toContain('>List<');expect(html).toContain('>Calendar<');
  expect(html).not.toContain('>Graph<');
 });
 it('offers Spots and Profile, and no Constellations subview',()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Promise(()=>{})));vi.stubGlobal('window',{location:{hash:'#/memory/spots'}});
  const html=renderToStaticMarkup(<MemoryPanel subview="spots"/>);
  expect(html).toContain('Spots');expect(html).toContain('Profile');
  expect(html).not.toContain('Constellations');expect(html).not.toContain('#/memory/constellation');
 });
 it('treats an old constellation link as an unsupported Memory link',()=>{
  expect(parseMemoryDestination('memory/constellation').kind).toBe('invalid-memory');
  expect(parseMemoryDestination('memory/constellation?id=synthetic-owner:node:1&explore=1').kind).toBe('invalid-memory');
  expect(resolveRoute('memory/constellation')).toBe('memory');
 });
});
