import type {OverviewV1} from './model';
export function greeting(timezone:string,now:Date):string {
 try {
  const hour=Number(new Intl.DateTimeFormat('en',{timeZone:timezone,hour:'numeric',hourCycle:'h23'}).format(now));
  if(!Number.isFinite(hour))return 'Hello.';
  return hour>=5&&hour<12?'Good morning.':hour>=12&&hour<17?'Good afternoon.':'Good evening.';
 }catch{return 'Hello.';}
}
export function homeBrief(data:OverviewV1):string {
 const waiting=data.waiting.count?`${data.waiting.count} ${data.waiting.count===1?'decision is':'decisions are'} waiting for you.`:'No decisions are waiting.';
 const next=data.next_card?.label.trim()?`${data.next_card.label} is next on your recorded plan.`:'No next card is recorded.';
 return `${waiting} ${next}`;
}
