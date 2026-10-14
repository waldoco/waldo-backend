// Read-only interval algebra. No events inferred absent from truncated lists.
export type TimeRange=Readonly<{from:string;to:string}>;
export type BusyInterval=Readonly<{start:string;end:string}>;
const instant=(s:string)=>{if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))throw new Error('explicit-offset instant required');return Date.parse(s);};
const merge=(rows:readonly number[][]):number[][]=>{const out:number[][]=[];for(const [a,b]of [...rows].sort((x,y)=>x[0]!-y[0]!)){const last=out.at(-1);if(last&&a!<=last[1]!)last[1]=Math.max(last[1]!,b!);else out.push([a!,b!]);}return out;};
export const availabilityWindows=(range:TimeRange,busy:readonly BusyInterval[],windows:readonly BusyInterval[],duration:number):readonly BusyInterval[]=>{
 const from=instant(range.from),to=instant(range.to);if(from>=to||!Number.isInteger(duration)||duration<1)throw new Error('invalid availability range/duration');
 const intervals=(rows:readonly BusyInterval[])=>rows.map(r=>{const a=instant(r.start),b=instant(r.end);if(a>=b)throw new Error('invalid availability interval');return [Math.max(a,from),Math.min(b,to)];}).filter(([a,b])=>a!<b!);
 const blocked=merge(intervals(busy)),allowed=windows.length?merge(intervals(windows)):[[from,to]];const result:BusyInterval[]=[];
 for(const [a,b]of allowed){let cursor=a!;for(const [x,y]of blocked){if(y!<=cursor||x!>=b!)continue;if(x!>cursor&&(x!-cursor)>=duration*60000)result.push({start:new Date(cursor).toISOString(),end:new Date(Math.min(x!,b!)).toISOString()});cursor=Math.max(cursor,y!);if(cursor>=b!)break;}if(b!-cursor>=duration*60000)result.push({start:new Date(cursor).toISOString(),end:new Date(b!).toISOString()});}
 return result;
};
export type FreeWindow=Readonly<{start:string;end:string;minutes:number}>;
// The same instants written in the owner's zone with their length, so the model never converts zones or subtracts times.
const zoned=(ms:number,timeZone:string)=>{
 const part=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'longOffset'}).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
 return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}${part.timeZoneName==='GMT'?'+00:00':part.timeZoneName!.slice(3)}`;
};
export const ownerWindows=(windows:readonly BusyInterval[],timeZone:string):readonly FreeWindow[]=>
 windows.map(w=>{const a=Date.parse(w.start),b=Date.parse(w.end);return {start:zoned(a,timeZone),end:zoned(b,timeZone),minutes:Math.floor((b-a)/60000)};});
