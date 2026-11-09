// workerd keeps each Set-Cookie separate; the Workers Headers type does not declare the accessor.
export const setCookies = (response: Response): string[] => (response.headers as unknown as { getSetCookie(): string[] }).getSetCookie();

// One browser's cookies as the OAuth binding sees them: what each Set-Cookie leaves behind and what the next request
// carries. Max-Age=0 removes; path and expiry matching are left to the binding's own checks.
export const cookieJar = () => {
  const cookies = new Map<string, string>();
  return {
    take(response: Response) {
      for (const line of setCookies(response)) {
        const [pair, ...attributes] = line.split('; ');
        const at = pair!.indexOf('=');
        const name = pair!.slice(0, at);
        if (attributes.includes('Max-Age=0')) cookies.delete(name);
        else cookies.set(name, pair!.slice(at + 1));
      }
      return response;
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    size: () => cookies.size,
  };
};
