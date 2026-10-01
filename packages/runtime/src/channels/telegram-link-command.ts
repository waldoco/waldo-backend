// Exact ten-character alphabet of the console link issuer, not invite codes.
export type CodedSetup = {subject:string;updateId:number;code:string};
export function parseCodedSetup(value:unknown):CodedSetup|null {
 if(!value||typeof value!=='object')return null;
 const u=value as {update_id?:unknown;message?:{from?:{id?:unknown};chat?:{id?:unknown;type?:unknown};text?:unknown}};
 const m=u.message;
 if(!Number.isSafeInteger(u.update_id)||Number(u.update_id)<0||!m||!Number.isSafeInteger(m.from?.id)||Number(m.from?.id)<=0||m.chat?.type!=='private'||m.chat.id!==m.from?.id||typeof m.text!=='string')return null;
 const parts=m.text.trim().split(/\s+/);
 if(parts.length!==2||!['/start','/link'].includes(parts[0]!))return null;
 const code=parts[1]!.toUpperCase();
 if(!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(code))return null;
 return {subject:String(m.from.id),updateId:Number(u.update_id),code};
}
