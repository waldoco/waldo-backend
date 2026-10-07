// Narrow lexer for the fixed PL/pgSQL assertion declaration, not agent logic or
// a general SQL interpreter. Comments cannot supply executable array entries.
export function canonicalHistoryVersions(sql){
 // Only the reviewed single DO block is supported. Additional dollar-quoted
 // strings/bodies fail closed rather than becoming a second declaration source.
 const trimmed=sql.trim(),open='do $assertion$',close='$assertion$;';
 if(!trimmed.startsWith(open)||!trimmed.endsWith(close))throw Error('unsupported SQL assertion wrapper');
 sql=trimmed.slice(open.length,-close.length);
 let i=0;const tokens=[];
 const letter=c=>c!==undefined&&((c>='a'&&c<='z')||(c>='A'&&c<='Z')||c==='_');
 const digit=c=>c!==undefined&&c>='0'&&c<='9';
 while(i<sql.length){
  const c=sql[i];
  if(c===' '||c==='\t'||c==='\r'||c==='\n'){i++;continue;}
  if(sql.startsWith('--',i)){while(i<sql.length&&sql[i]!=='\n')i++;continue;}
  if(sql.startsWith('/*',i)){i+=2;let depth=1;while(i<sql.length&&depth){if(sql.startsWith('/*',i)){depth++;i+=2;}else if(sql.startsWith('*/',i)){depth--;i+=2;}else i++;}if(depth)throw Error('unterminated SQL comment');continue;}
  if(c==="'"){i++;let text='',closed=false;while(i<sql.length){if(sql[i]==="'"){if(sql[i+1]==="'"){text+="'";i+=2;}else{i++;closed=true;break;}}else text+=sql[i++];}if(!closed)throw Error('unterminated SQL string');tokens.push({kind:'string',text});continue;}
  if(c==='"'){i++;let closed=false;while(i<sql.length){if(sql[i]==='"'){if(sql[i+1]==='"')i+=2;else{i++;closed=true;break;}}else i++;}if(!closed)throw Error('unterminated quoted identifier');tokens.push({kind:'quoted',text:''});continue;}
  if(letter(c)){let text='';while(letter(sql[i])||digit(sql[i]))text+=sql[i++];tokens.push({kind:'word',text:text.toLowerCase()});continue;}
  if(sql.startsWith(':=',i)){tokens.push({kind:'symbol',text:':='});i+=2;continue;}
  if(c==='$'||c==='\\')throw Error('unsupported SQL assertion token');
  tokens.push({kind:'symbol',text:c});i++;
 }
 const prefix=['expected','constant','text','[',']',':=','array','['];let start=-1;
 for(let j=0;j<tokens.length;j++)if(tokens[j].kind==='word'&&tokens[j].text==='expected'&&prefix.every((text,k)=>tokens[j+k]?.text===text&&tokens[j+k]?.kind===([0,1,2,6].includes(k)?'word':'symbol'))){
  if(start!==-1)throw Error('duplicate expected SQL declaration');start=j+prefix.length;
 }
 if(start<0)throw Error('expected SQL declaration absent');
 const versions=[];let cursor=start;
 for(;;){const token=tokens[cursor++];if(token?.kind!=='string'||token.text.length!==14||![...token.text].every(digit))throw Error('invalid executable SQL history entry');versions.push(token.text);
  const separator=tokens[cursor++];if(separator?.text===']'){if(tokens[cursor]?.text!==';')throw Error('invalid SQL history terminator');return versions;}
  if(separator?.text!==',')throw Error('invalid SQL history separator');
 }
}
