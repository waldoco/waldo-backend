import type{OwnerDirectory}from'../identity/owner-directory';
import type{TelegramLinkInbox}from'./telegram-link-inbox';
export const LINK_UNCERTAIN='Linking could not be confirmed. Check your console before trying a new code.';
const CURRENT='This chat is currently linked. Check your console to manage it.';
// One deliberate RPC per receipt. Absence of a presence is never evidence about
// a lost/committed redemption. No model or owner runtime is involved.
export async function drainLinkReceipt(inbox:TelegramLinkInbox,directory:OwnerDirectory,bindingLive:()=>boolean,subject:string):Promise<void>{
 const row=(await inbox.records()).find(r=>r.state==='admitted'||r.state==='attempting');if(!row)return;
 if(!bindingLive()){await inbox.complete(row.id);return;}
 if(row.state==='attempting'){
  let current=false;try{current=Boolean(await directory.byPresence('telegram',subject))}catch{}
  await inbox.freeze(row.id,current?CURRENT:LINK_UNCERTAIN);return;
 }
 let current;
 try{current=await directory.byPresence('telegram',subject)}catch{await inbox.freeze(row.id,LINK_UNCERTAIN);return;}
 if(current){await inbox.freeze(row.id,CURRENT);return;}
 if(!bindingLive()){await inbox.complete(row.id);return;}
 const attempt=await inbox.begin(row.id);if(!attempt)return;
 let result:{kind:string}={kind:'uncertain'};
 if(!bindingLive()){await inbox.complete(row.id);return;}
 try{result=directory.redeemHashed?await directory.redeemHashed('telegram',subject,attempt.hash):result}catch{}
 let text=LINK_UNCERTAIN;
 if(result.kind==='rejected')text='That code did not work. Get a new one from your console.';
 else if(result.kind==='redeemed'){try{if(await directory.byPresence('telegram',subject))text='Linked. This chat now talks to your Waldo.';}catch{}}
 else{try{if(await directory.byPresence('telegram',subject))text=CURRENT;}catch{}}
 await inbox.freeze(row.id,text);
}
