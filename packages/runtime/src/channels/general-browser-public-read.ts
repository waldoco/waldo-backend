import type {BrowserContext} from '@cloudflare/playwright';

// Public reads do not need background workers or bidirectional socket actions.
// This uses the same per-frame init-script mechanism as Playwright's
// serviceWorkers:block option, which connect cannot apply to a default context.
export async function prepareGeneralPublicRead(context:BrowserContext):Promise<boolean>{
 if(context.serviceWorkers().length)return false;
 await context.addInitScript(()=>{
  if(navigator.serviceWorker){
   const prototype=Object.getPrototypeOf(navigator.serviceWorker);
   if(Object.getOwnPropertyDescriptor(prototype,'register')?.configurable!==false)Object.defineProperty(prototype,'register',{configurable:false,writable:false,value:async()=>{throw Error('Service workers are unavailable in public read mode');}});
  }
 });
 await context.routeWebSocket('**/*',socket=>socket.close());
 return true;
}
