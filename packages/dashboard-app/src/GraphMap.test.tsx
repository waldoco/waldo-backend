// @vitest-environment happy-dom
import {act,useState} from 'react';import {createRoot} from 'react-dom/client';import {it,expect,vi} from 'vitest';import {GraphMap} from './GraphMap';
it('preserves nodes, highlights keyboard neighbors, selects, zooms, pans and resets',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const select=vi.fn();const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const nodes=[{id:'a',kind:'pattern' as const,label:'A long tentative saved pattern'},{id:'b',kind:'pattern' as const,label:'Neighbor'},{id:'c',kind:'spot' as const,label:'An isolated Spot'}];
 try{
  await act(async()=>root.render(<GraphMap nodes={nodes} links={[{from:'a',to:'b',relation:'saved',kind:'association'}]} selected="a" onSelect={select} reduced/>));
  expect(host.querySelectorAll('[data-node]')).toHaveLength(3);expect(host.querySelector('[data-reduced-motion]')?.getAttribute('data-reduced-motion')).toBe('true');
  const b=host.querySelector('[data-node=b]') as SVGGElement;
  await act(async()=>b.focus());expect(host.querySelector('.graph-edge')?.classList.contains('active')).toBe(true);
  await act(async()=>b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));expect(select).toHaveBeenCalledWith('b');
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());expect(host.querySelector('output')?.textContent).toBe('115%');
  const before=host.querySelector('svg>g')!.getAttribute('transform');await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Pan right"]')!.click());expect(host.querySelector('svg>g')!.getAttribute('transform')).not.toBe(before);
  await act(async()=>[...host.querySelectorAll('button')].find(n=>n.textContent==='Reset view')!.click());expect(host.querySelector('output')?.textContent).toBe('100%');
  for(let i=0;i<20;i++)await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());expect(host.querySelector('output')?.textContent).toBe('75%');
  await act(async()=>[...host.querySelectorAll('button')].find(n=>n.textContent==='Reset view')!.click());
  const a=host.querySelector('[data-node=a]')!;const initial=a.getAttribute('transform');
  await act(async()=>a.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientX:10,clientY:10,bubbles:true,pointerType:'mouse'})));
  await act(async()=>host.querySelector('svg')!.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:50,clientY:40,bubbles:true,pointerType:'mouse'})));
  expect(a.getAttribute('transform')).not.toBe(initial);
  await act(async()=>host.querySelector('svg')!.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,bubbles:true})));
  await act(async()=>a.dispatchEvent(new MouseEvent('click',{bubbles:true})));expect(select).toHaveBeenCalledTimes(1);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it('preserves zoom, pan and dragged positions when a parent rerenders inline nodes after Enter selection',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 function Parent(){const [selected,setSelected]=useState('a');return <GraphMap nodes={[{id:'a',kind:'pattern',label:'First'},{id:'b',kind:'pattern',label:'Second'}]} links={[{from:'a',to:'b',relation:'saved',kind:'association'}]} selected={selected} onSelect={setSelected} reduced/>;}
 try{
  await act(async()=>root.render(<Parent/>));
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Pan right"]')!.click());
  const a=host.querySelector('[data-node=a]')!;
  await act(async()=>a.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientX:10,clientY:10,bubbles:true,pointerType:'mouse'})));
  await act(async()=>host.querySelector('svg')!.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:50,clientY:40,bubbles:true,pointerType:'mouse'})));
  await act(async()=>host.querySelector('svg')!.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,bubbles:true})));
  const moved=a.getAttribute('transform'),view=host.querySelector('svg>g')!.getAttribute('transform');
  await act(async()=>host.querySelector('[data-node=b]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  expect(host.querySelector('output')?.textContent).toBe('115%');expect(a.getAttribute('transform')).toBe(moved);expect(host.querySelector('svg>g')!.getAttribute('transform')).toBe(view);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
