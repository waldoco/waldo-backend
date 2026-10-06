// @vitest-environment happy-dom
import {act,useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
import {Dashboard,resolveRoute} from './App';
import type {OverviewV1} from './model';
it('old and new settings links load the correct read-only projection and preserve history',async()=>{
 const calls:string[]=[];
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);return new Response('{}',{status:503});}));
 const data:OverviewV1={version:1,as_of:'2026-10-03T00:00:00Z',timezone:'UTC',brief:{status:'not_sent',at:null},waiting:{count:0,first:null},next_card:null,latest_activity:null,services:[]};
 function Harness(){const [hash,setHash]=useState(window.location.hash);useEffect(()=>{const fn=()=>setHash(window.location.hash);window.addEventListener('hashchange',fn);return()=>window.removeEventListener('hashchange',fn);},[]);return <Dashboard data={data} route={resolveRoute(hash.replace(/^#\//,''))}/>;}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const settle=async()=>act(async()=>{await new Promise(r=>setTimeout(r,10));});
 try{
  window.history.replaceState(null,'','#/settings/sessions');await act(async()=>root.render(<Harness/>));await settle();
  expect(calls.at(-1)).toContain('view=connections');expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('Account');
  await act(async()=>{window.location.hash='#/usage';});await settle();expect(calls.at(-1)).toContain('view=usage');expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('Usage');
  await act(async()=>window.history.back());await settle();expect(calls.at(-1)).toContain('view=connections');
  await act(async()=>{window.location.hash='#/settings/day';});await settle();expect(calls.at(-1)).toContain('view=day');
  expect(vi.mocked(fetch).mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
