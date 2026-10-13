import { PUBLIC_WEB_ORIGIN, isPublicWebUrl } from './public-web-policy';

// The request filter every retained public-browser page runs behind. Exported so the S0 network-block
// check drives this exact predicate rather than a copy.
export const publicBrowserRequestAuthorizer=(allowedOrigins:readonly string[],egressAllowlist?:readonly string[])=>async(url:string,method:string):Promise<boolean>=>{
 if(!['GET','HEAD'].includes(method))return false;
 try{return isPublicWebUrl(url,egressAllowlist)&&(allowedOrigins.includes(PUBLIC_WEB_ORIGIN)||allowedOrigins.includes(new URL(url).origin));}catch{return false;}
};
