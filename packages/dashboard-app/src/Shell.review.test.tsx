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
it('drawer Enter opens, Escape closes, and Menu regains focus',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('matchMedia',vi.fn((query:string)=>({matches:query.includes('max-width'),addEventListener(){},removeEventListener(){}})));
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:404})));
 const proto=HTMLDialogElement.prototype;
 const show=vi.spyOn(proto,'showModal').mockImplementation(function(this:HTMLDialogElement){this.open=true;});
 const close=vi.spyOn(proto,'close').mockImplementation(function(this:HTMLDialogElement){this.open=false;this.dispatchEvent(new Event('close'));});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(<App/>));
  const menu=host.querySelector('.mobile-header button') as HTMLButtonElement;const dialog=host.querySelector('dialog')!;
  menu.focus();await act(async()=>menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
  expect(dialog.open).toBe(true);expect(menu.getAttribute('aria-expanded')).toBe('true');expect(document.activeElement?.textContent).toBe('Close menu');
  await act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  expect(dialog.open).toBe(false);expect(menu.getAttribute('aria-expanded')).toBe('false');expect(document.activeElement).toBe(menu);
 }finally{await act(async()=>root.unmount());host.remove();show.mockRestore();close.mockRestore();vi.unstubAllGlobals();}
});
