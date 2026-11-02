import {equalText} from './communications-crypto.js';
import {BUSINESS_PHONE,customerOrigin} from './communications.js';
const enc=new TextEncoder();
const b64=buffer=>btoa(String.fromCharCode(...new Uint8Array(buffer)));
async function hmac(secret,data,hash){const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash},false,['sign']);return b64(await crypto.subtle.sign('HMAC',key,enc.encode(data)));}
export async function verifyTwilio(request,env,raw){
 if(!env.TWILIO_AUTH_TOKEN||!env.TWILIO_ACCOUNT_SID)return null;
 if(!(request.headers.get('content-type')||'').includes('application/x-www-form-urlencoded'))return null;
 const fields=new URLSearchParams(raw),url=new URL(request.url);
 let signed=customerOrigin(env)+url.pathname+url.search;
 for(const key of [...new Set(fields.keys())].sort())for(const value of [...new Set(fields.getAll(key))].sort())signed+=key+value;
 const signature=await hmac(enc.encode(env.TWILIO_AUTH_TOKEN),signed,'SHA-1');
 if(!equalText(signature,request.headers.get('x-twilio-signature'))||fields.get('AccountSid')!==env.TWILIO_ACCOUNT_SID)return null;
 return fields;
}
export async function verifyResend(request,env,raw){
 const id=request.headers.get('svix-id'),timestamp=request.headers.get('svix-timestamp');
 if(!env.RESEND_WEBHOOK_SECRET?.startsWith('whsec_')||!id||!/^\d{9,12}$/.test(timestamp||'')||Math.abs(Date.now()/1000-Number(timestamp))>300)return null;
 let secret;try{secret=Uint8Array.from(atob(env.RESEND_WEBHOOK_SECRET.slice(6)),c=>c.charCodeAt(0));}catch{return null;}
 const expected=await hmac(secret,id+'.'+timestamp+'.'+raw,'SHA-256');
 if(!(request.headers.get('svix-signature')||'').split(' ').some(s=>s.startsWith('v1,')&&equalText(s.slice(3),expected)))return null;
 return {id,event:JSON.parse(raw)};
}
export async function callbackOnce(env,key){const r=await env.DB.prepare(`INSERT OR IGNORE INTO message_callback_events(event_key,received_at) VALUES (?,?)`).bind(key,new Date().toISOString()).run();return r.meta?.changes===1;}
export {BUSINESS_PHONE};
