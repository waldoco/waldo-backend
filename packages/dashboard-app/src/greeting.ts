export function greeting(timezone:string,now:Date):string {
 try {
  const hour=Number(new Intl.DateTimeFormat('en',{timeZone:timezone,hour:'numeric',hourCycle:'h23'}).format(now));
  if(!Number.isFinite(hour)||hour<5)return 'Hello.';
  return hour>=5&&hour<12?'Good morning.':hour>=12&&hour<17?'Good afternoon.':'Good evening.';
 }catch{return 'Hello.';}
}
