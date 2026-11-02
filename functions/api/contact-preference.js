import {json,sameOrigin} from '../_lib/auth.js';
import {linkToken,equalText} from '../_lib/communications-crypto.js';
import {validatePreference,normalizePhone} from '../_lib/communications.js';

async function booking(env,reference,token){
 if(!/^RD-[A-Z0-9]{8,32}$/.test(reference||'')||!/^[a-f0-9]{64}$/.test(token||'')||!equalText(token,await linkToken(env,'updates',reference)))return null;
 return env.DB.prepare(`SELECT b.reference,b.phone,p.channel,p.sms_consent FROM bookings b JOIN booking_contact_preferences p ON p.booking_reference=b.reference WHERE b.reference=?`).bind(reference).first();
}
export async function onRequestGet({request,env}){
 try{const u=new URL(request.url),b=await booking(env,u.searchParams.get('ref'),u.searchParams.get('token'));return b?json({channel:b.channel}):json({error:'This update-preference link is invalid.'},404);}catch{return json({error:'Update preferences are unavailable.'},503);}
}
export async function onRequestPost({request,env}){
 if(!sameOrigin(request))return json({error:'Request rejected.'},403);
 if(!(request.headers.get('content-type')||'').includes('application/json'))return json({error:'JSON required.'},415);
 try{
  const raw=await request.text();if(new TextEncoder().encode(raw).length>2048)return json({error:'Request too large.'},413);
  const body=JSON.parse(raw),b=await booking(env,body.reference,body.token);if(!b)return json({error:'This update-preference link is invalid.'},404);
  const pref=await validatePreference(env,{...body,phone:b.phone});
  if(pref.channel==='sms'&&await env.DB.prepare('SELECT phone_e164 FROM sms_suppressions WHERE phone_e164=?').bind(normalizePhone(b.phone)).first())return json({error:'Reply START from your phone to the business number before enabling texts again.'},409);
  await env.DB.prepare(`UPDATE booking_contact_preferences SET channel=?,sms_consent=?,consented_at=?,updated_at=? WHERE booking_reference=?`).bind(pref.channel,pref.smsConsent?1:0,new Date().toISOString(),new Date().toISOString(),b.reference).run();
  return json({ok:true,channel:pref.channel});
 }catch(error){return json({error:error.status?error.message:'Could not update your communication preference.'},error.status||503);}
}
