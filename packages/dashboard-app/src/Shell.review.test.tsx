// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect,vi} from 'vitest';
import {App,Dashboard,resolveRoute} from './App';
import {OwnerControlsPanel} from './OwnerControls';
import type {OverviewV1} from './model';
const data:OverviewV1={version:1,as_of:'2026-10-03T00:00:00Z',timezone:'UTC',brief:{status:'not_sent',at:null},waiting:{count:0,first:null},next_card:null,latest_activity:null,services:[]};
it('keeps invite privacy disclosure visible even while loading',()=>{
 expect(renderToStaticMarkup(<OwnerControlsPanel view="invites"/>)).toContain('Invites let someone join Waldo. They do not share your data.');
});
it('shows explicit notice for unknown settings destinations',()=>{
 const route=resolveRoute('settings/missing');
 expect(renderToStaticMarkup(<Dashboard data={data} route={route}/>)).toContain('Settings page not found');
 expect(renderToStaticMarkup(<Dashboard data={data} route={route}/>)).not.toContain('Nothing waiting.');
});
it('renders one top bar with four destinations and a Settings link, and no drawer or Menu button',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:404})));
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(<App/>));
  const links=[...host.querySelectorAll('nav[aria-label="Dashboard pages"] a')].map(a=>a.textContent?.trim());
  expect(links).toEqual(['Today','Waiting','Memory','Patrol']);
  expect(host.querySelector('a[aria-label="Settings"]')?.getAttribute('href')).toBe('#/settings');
  expect(host.querySelector('dialog')).toBeNull();
  expect([...host.querySelectorAll('button')].some(b=>b.textContent==='Menu')).toBe(false);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it('unknown hashes show a not-found destination and recover to Today through navigation',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener(){},removeEventListener(){}})));
 vi.stubGlobal('fetch',vi.fn(async(input)=>new Response(JSON.stringify(String(input).includes('overview')?data:{}),{status:String(input).includes('overview')?200:404})));
 window.location.hash='#/qa-dld-20261003-missing';
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(<App/>));
  expect(host.querySelector('main')?.textContent).toContain('Page not found');
  expect(host.querySelector('main')?.textContent).not.toContain('Nothing waiting.');
  expect(host.querySelector('main a[href="#/today"]')).not.toBeNull();
  await act(async()=>{window.location.hash='#/today';window.dispatchEvent(new Event('hashchange'));});
  expect(host.querySelector('main')?.textContent).toContain('Nothing needs you.');
 }finally{await act(async()=>root.unmount());host.remove();window.location.hash='';vi.unstubAllGlobals();}
});
it('removes the greeting timer and both refresh listeners on unmount',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener(){},removeEventListener(){}})));
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:404})));
 const interval=vi.spyOn(window,'setInterval'),clear=vi.spyOn(window,'clearInterval');
 const addWindow=vi.spyOn(window,'addEventListener'),removeWindow=vi.spyOn(window,'removeEventListener');
 const addDocument=vi.spyOn(document,'addEventListener'),removeDocument=vi.spyOn(document,'removeEventListener');
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(<App/>));
  const index=interval.mock.calls.findIndex(call=>call[1]===60000);expect(index).toBeGreaterThanOrEqual(0);
  const tick=interval.mock.calls[index]![0],timer=interval.mock.results[index]!.value;
  expect(addWindow).toHaveBeenCalledWith('focus',tick);expect(addDocument).toHaveBeenCalledWith('visibilitychange',tick);
  await act(async()=>root.unmount());
  expect(clear).toHaveBeenCalledWith(timer);expect(removeWindow).toHaveBeenCalledWith('focus',tick);expect(removeDocument).toHaveBeenCalledWith('visibilitychange',tick);
 }finally{host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();}
});
