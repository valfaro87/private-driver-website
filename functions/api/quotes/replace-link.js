import {json,ownerSession,sameOrigin,sha256Hex} from '../../_lib/auth.js';
import {notificationStatement,quoteTokenStatement,wakeCommunications} from '../../_lib/communications.js';
export async function onRequestPost(context){
 const {request,env}=context;
 if(!env.DB)return json({error:'Database unavailable.'},503);
 if(!sameOrigin(request))return json({error:'Request rejected.'},403);
 if(!await ownerSession(request,env))return json({error:'Please sign in as the owner.'},401);
 if(!(request.headers.get('content-type')||'').includes('application/json'))return json({error:'JSON required.'},415);
 let body;try{const raw=await request.text();if(new TextEncoder().encode(raw).length>2000)return json({error:'Request too large.'},413);body=JSON.parse(raw);}catch{return json({error:'Invalid request.'},400);}
 if(typeof body?.reference!=='string'||!/^QT-[A-Z0-9]{12}$/.test(body.reference))return json({error:'Invalid quote reference.'},400);
 try{
  const quote=await env.DB.prepare('SELECT reference,booking_reference,status,customer_token_hash FROM ride_quotes WHERE reference=?').bind(body.reference).first();
  if(!quote)return json({error:'Quote not found.'},404);
  if(quote.status!=='accepted')return json({error:'Only accepted quotes can receive a replacement link.'},409);
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
  const hash=await sha256Hex(token),time=new Date().toISOString();
  const update=env.DB.prepare(`UPDATE ride_quotes SET customer_token_hash=?,updated_at=? WHERE reference=? AND status='accepted' AND customer_token_hash=?`).bind(hash,time,quote.reference,quote.customer_token_hash);
  const saved=await quoteTokenStatement(env,quote.reference,token);
  const notice=await notificationStatement(env,quote.booking_reference,'quote_replaced','quote-link:'+quote.reference+':'+hash,{quoteReference:quote.reference,token},{quoteGuard:{reference:quote.reference,status:'accepted',tokenHash:hash}});
  const [result]=await env.DB.batch([update,saved,notice].filter(Boolean));
  if(result.meta?.changes!==1)return json({error:'The quote changed. Refresh before replacing its link.'},409);
  const url=new URL('/quote.html',request.url);url.searchParams.set('token',token);
  await wakeCommunications(context);
  return json({ok:true,message:'Replacement link generated.',notificationQueued:!!notice,emailSent:false,quote:{reference:quote.reference,status:'accepted',customerUrl:url.toString()}});
 }catch{return json({error:'Could not replace the quote link. Check customer messaging configuration and try again.'},503);}
}
