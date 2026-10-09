import {LIMITS,validatePath} from '@waldo/workspace';
import type {APIResponse} from '@cloudflare/playwright';
import {BrowserDownloadError,type BrowserDownloadMetadata} from './browser-download-workspace';
import {generalDigest} from './general-browser-observation';

export async function browserHttpAttachment(response:APIResponse,body:()=>Promise<Uint8Array>):Promise<Readonly<{metadata:BrowserDownloadMetadata;bytes:Uint8Array}>>{
 const headers=response.headers(),disposition=headers['content-disposition']??'';
 if(response.status()!==200||!/^attachment(?:\s*;|\s*$)/i.test(disposition))throw new BrowserDownloadError('rejected');
 const encoded=/;\s*filename\*=UTF-8''([^;]*)/i.exec(disposition),plain=/;\s*filename=(?:"([^"\r\n]*)"|([^;\s]+))/i.exec(disposition);
 let filename='attachment.bin';
 try{filename=encoded?decodeURIComponent(encoded[1]!):plain?(plain[1]??plain[2])!:filename;validatePath(filename);}catch{throw new BrowserDownloadError('rejected');}
 if(filename.includes('/')||filename.includes('\\'))throw new BrowserDownloadError('rejected');
 const mime=(headers['content-type']??'application/octet-stream').split(';')[0]!.trim().toLowerCase();
 if(!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime))throw new BrowserDownloadError('rejected');
 const length=headers['content-length'];
 if(length!==undefined&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))))throw new BrowserDownloadError('rejected');
 if(length!==undefined&&Number(length)>LIMITS.fileBytes)throw new BrowserDownloadError('oversize');
 // The pinned APIResponse buffers the entire body. This is an import limit,
 // not a claim that an untrusted server cannot exceed transport memory.
 const bytes=new Uint8Array(await body());
 if(bytes.length>LIMITS.fileBytes)throw new BrowserDownloadError('oversize');
 if(!bytes.length)throw new BrowserDownloadError('rejected');
 return {bytes,metadata:{filename,mime,byte_size:bytes.length,sha256:await generalDigest(bytes)}};
}
