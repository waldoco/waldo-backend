// JSONC as Wrangler reads it: line and block comments and trailing commas are dropped, but only
// outside strings, so a URL's "//" or a quoted "," survives.
const outsideStrings = (text, step) => {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else {
      const [kept, next] = step(text, i);
      out += kept;
      i = next;
    }
  }
  return out;
};

const comments = (text, i) => {
  if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); return ['', end === -1 ? text.length : end]; }
  if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); return ['', end === -1 ? text.length : end + 2]; }
  return [text[i], i + 1];
};

const trailingCommas = (text, i) => {
  if (text[i] !== ',') return [text[i], i + 1];
  const next = text.slice(i + 1).search(/\S/);
  return [next !== -1 && '}]'.includes(text[i + 1 + next]) ? '' : ',', i + 1];
};

export const parseJsonc = (text) => JSON.parse(outsideStrings(outsideStrings(text, comments), trailingCommas));
