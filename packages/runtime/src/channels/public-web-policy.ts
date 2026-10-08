// Public-web browsing: any public http(s) page is readable. Only private/internal network targets and
// credentialed URLs are refused. This is the single network-block rule; it grants nothing else
// (logins, page writes and submits stay behind approvals elsewhere).
export const PUBLIC_WEB_ORIGIN = '*';
const privateV4 = (a: number, b: number): boolean =>
  a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
export const isPublicWebUrl = (value: string): boolean => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || host.includes(':')) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return !privateV4(Number(v4[1]), Number(v4[2]));
  if (!host.includes('.') || /^[0-9.x]+$/.test(host)) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|private|localdomain)$/.test(host);
};
