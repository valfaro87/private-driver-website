const enc=new TextEncoder(),dec=new TextDecoder();
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export function hasCommunicationsKey(env){return /^[a-f0-9]{64}$/i.test(env.COMMUNICATIONS_ENCRYPTION_KEY || '');}
async function key(env,purpose,algorithm,usages){
  if(!hasCommunicationsKey(env))throw new Error('Customer messaging encryption is not configured.');
  const raw=Uint8Array.from(env.COMMUNICATIONS_ENCRYPTION_KEY.match(/../g),x=>parseInt(x,16));
  const base=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode('mvbri-communications-v1'),info:enc.encode(purpose)},base,algorithm,false,usages);
}
export async function encryptMessage(env,value){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const aes=await key(env,'private-messages',{name:'AES-GCM',length:256},['encrypt']);
  const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,enc.encode(JSON.stringify(value)));
  // Build base64 in chunks to avoid argument limits for inline logo attachments.
  let binary='';for(let i=0;i<bytes.byteLength;i+=8192)binary+=String.fromCharCode(...new Uint8Array(bytes,i,Math.min(8192,bytes.byteLength-i)));
  return 'v1.'+b64(iv)+'.'+btoa(binary);
}
export async function decryptMessage(env,value){
  const [version,iv,data]=String(value).split('.');if(version!=='v1'||!iv||!data)throw new Error('Invalid encrypted message.');
  const aes=await key(env,'private-messages',{name:'AES-GCM',length:256},['decrypt']);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv)},aes,unb64(data))));
}
export async function linkToken(env,purpose,value){
  const hmac=await key(env,'customer-links',{name:'HMAC',hash:'SHA-256',length:256},['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',hmac,enc.encode(purpose+':'+value))),x=>x.toString(16).padStart(2,'0')).join('');
}
export function equalText(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
