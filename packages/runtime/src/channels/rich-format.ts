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
const telegramInline=(text:string):string=>{
 // Tokenize before escaping. Code is opaque; HTML is never trusted. No style,
 // images, autolinks or arbitrary markup are emitted.
 const tokens=/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;let out='',start=0;
 for(const m of text.matchAll(tokens)){
  out+=escapeRich(text.slice(start,m.index));
  out+=m[1]!==undefined?`<code>${escapeRich(m[1])}</code>`:`<b>${escapeRich(m[2]!)}</b>`;
  start=m.index!+m[0].length;
 }
 return out+escapeRich(text.slice(start));
};
export const telegramRichReply=(text:string):Readonly<{text:string;parse_mode:'HTML'}>=>{
 // Code alternatives precede links, so markup inside code stays literal.
 const token=/```(?:[^\n`]*\n)?([\s\S]*?)```|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s<>"'`()]+)\)|\*\*([^*\n]+)\*\*/g;let out='',start=0;
 for(const m of text.matchAll(token)){
  out+=escapeRich(text.slice(start,m.index));
  if(m[1]!==undefined)out+=`<pre>${escapeRich(m[1])}</pre>`;
  else if(m[2]!==undefined)out+=`<code>${escapeRich(m[2])}</code>`;
  else if(m[3]!==undefined)out+=`<a href="${escapeRich(m[4]!)}">${telegramInline(m[3])}</a>`;
  else out+=`<b>${escapeRich(m[5]!)}</b>`;
  start=m.index!+m[0].length;
 }
 out+=escapeRich(text.slice(start));return{text:out,parse_mode:'HTML'};
};
