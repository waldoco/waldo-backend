import type{ArtifactKind}from'@waldo/contracts';
// No raw HTML, external images, links, CSS, forms or scripts from an artifact body.
// Markdown is a deliberately small, inert subset. Unknown markup stays readable text.
export const escapeRich=(s:string)=>s.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
const inline=(s:string)=>escapeRich(s).replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
export const renderArtifactBody=(kind:ArtifactKind,body:string):string=>{
 if(kind==='data')return `<pre>${escapeRich(body)}</pre>`;
 const out:string[]=[];let list=false,fenced=false;const close=()=>{if(list){out.push('</ul>');list=false;}};
 for(const line of body.split('\n')){
  if(/^\s*```/.test(line)){close();out.push(fenced?'</code></pre>':'<pre><code>');fenced=!fenced;continue;}
  if(fenced){out.push(`${escapeRich(line)}\n`);continue;}
  const heading=/^(#{1,6})\s+(.+)$/.exec(line);const item=/^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line);
  if(item){if(!list){out.push('<ul>');list=true;}out.push(`<li>${item[1]===undefined?'':item[1]===' '?'☐ ':'☑ '}${inline(item[2]!)}</li>`);continue;}
  close();if(heading){const level=Math.min(6,heading[1]!.length+1);out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);}else if(line.trim())out.push(`<p>${inline(line)}</p>`);
 }
 close();if(fenced)out.push('</code></pre>');return out.join('');
};
// Applied only to already guarded final text. Convert existing HTTP(S) Markdown
// link tokens without changing their URL bytes. Raw model HTML remains text.
// Code stays opaque. Telegram forbids code entities nested in links/bold, so a
// code-styled link label uses literal escaped contents rather than a code entity.
// Bold may wrap a link and a link label may carry bold; a link never nests in a link.
// Unsupported nesting/malformed delimiters leave the reply literal.
const parseTelegram=(text:string, inBold=false, inLink=false):string|null=>{
 const label=inBold||inLink;
 let out='',i=0;
 while(i<text.length){
  if(text[i]==='\\'&&text[i+1]&&/[\\`*\[\]()]/.test(text[i+1]!)){
   out+=escapeRich(text.slice(i,i+2));i+=2;continue;
  }
  if(text.startsWith('```',i)){
   if(label)return null;
   const end=text.indexOf('```',i+3);if(end<0)return null;
   let body=text.slice(i+3,end);const first=body.indexOf('\n');
   if(first>=0&&/^[a-zA-Z0-9_-]*$/.test(body.slice(0,first)))body=body.slice(first+1);
   out+=`<pre>${escapeRich(body)}</pre>`;i=end+3;continue;
  }
  if(text[i]==='`'){
   if(text[i+1]==='`')return null;
   const end=text.indexOf('`',i+1);if(end<0||text.slice(i+1,end).includes('\n'))return null;
   const body=escapeRich(text.slice(i+1,end));
   out+=label?body:`<code>${body}</code>`;i=end+1;continue;
  }
  if(text.startsWith('**',i)){
   if(text[i+2]==='*'||text[i-1]==='*')return null;
   const end=text.indexOf('**',i+2);if(end<0)return null;
   const body=text.slice(i+2,end);
   if(!label&&/^`[^`\n]+`$/.test(body)){
    out+=`<code>${escapeRich(body.slice(1,-1))}</code>`;i=end+2;continue;
   }
   if(!body||body.trim()!==body||/[*\n]/.test(body)||(inLink&&body.includes(']('))||text[end+2]==='*')return null;
   const contents=parseTelegram(body,true,inLink);if(contents===null)return null;
   out+=`<b>${contents}</b>`;i=end+2;continue;
  }
  if(text[i]==='['&&!inLink){
   const close=text.indexOf('](',i+1);
   if(close>=0){const end=text.indexOf(')',close+2);
    if(end>=0){const url=text.slice(close+2,end);
     if(/^https?:\/\/[^\s<>"'`()]+$/.test(url)){
      const labelText=text.slice(i+1,close);if(labelText.includes('['))return null;
      const name=parseTelegram(labelText,inBold,true);if(name===null)return null;
      out+=`<a href="${escapeRich(url)}">${name}</a>`;i=end+1;continue;
     }
    }
   }
  }
  out+=escapeRich(text[i]!);i++;
 }
 return out;
};
// The plain text sent when Telegram rejects the HTML: emphasis markers dropped, links as "text (url)", code and
// fences untouched. Bullets and stars that are not paired around a word stay as written. Only the rejection retry
// uses it; the frozen fallback_text stays the Markdown source that split parts are rendered from.
export const plainTelegram=(text:string):string=>text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part,index)=>index%2?part:part
 .replace(/\[([^\[\]\n]+)\]\((https?:\/\/[^\s<>"'`()]+)\)/g,'$1 ($2)')
 .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g,'$1')
 .replace(/__(?=\S)([^_\n]*?\S)__/g,'$1')
 .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/gm,'$1$2')).join('');
// WhatsApp and iMessage show text as typed: **bold** becomes WhatsApp's *bold*, a link its label and address (the address
// alone when the label is that address or its site), and heading marks go. Code and fences stay as written.
const sameAddress=(label:string,url:string):boolean=>{
 const bare=(s:string)=>s.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/$/,'');
 try{return bare(label)===bare(url)||bare(label)===new URL(url).hostname.replace(/^www\./,'');}catch{return false;}
};
export const plainChatText=(text:string):string=>text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part,index)=>index%2?part:part
 .replace(/\[([^\[\]\n]+)\]\((https?:\/\/[^\s<>"'`()]+)\)/g,(_,label:string,url:string)=>sameAddress(label,url)?url:`${label} (${url})`)
 .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g,'*$1*')
 .replace(/^#{1,6}[ \t]+/gm,'')).join('');
export const telegramRichReply=(text:string):Readonly<{text:string;parse_mode:'HTML';fallback_text:string}>=>({text:parseTelegram(text)??escapeRich(text),parse_mode:'HTML',fallback_text:text});
