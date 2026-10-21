import {expect,it,vi} from 'vitest';
import {commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
it('reports binding and SDK readiness independently of trial registration without provider I/O',async()=>{
 const config=await import('../src/channels/browser-public-read-configuration');
 expect(config.cloudflareBrowserProviderReadiness({BROWSER:{} as never})).toBe(false);
 const loader=vi.fn(commonBrowserFixtureLoader);
 config.configureStagingPublicBrowser(loader);
 expect(config.cloudflareBrowserProviderReadiness({BROWSER:{} as never})).toBe(true);
 expect(config.cloudflareBrowserProviderReadiness({})).toBe(false);
 expect(loader).not.toHaveBeenCalled();
});
