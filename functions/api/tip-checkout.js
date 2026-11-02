import {json,sameOrigin} from '../_lib/auth.js';
import {authorizedReceipt} from '../_lib/postride.js';
import {prepareTipCheckout,reconcileTip} from '../_lib/square-tip.js';
export async function onRequestGet({request,env}){
 if(!env.DB)return json({error:'Optional tips unavailable.'},503);
 const params=new URL(request.url).searchParams;
 try{
  const authorized=await authorizedReceipt(env,params.get('ref'),params.get('token'));if(!authorized)return json({error:'Use the private optional-tip link sent after your completed, paid ride.'},404);
  const row=await env.DB.prepare('SELECT amount_cents,status,square_environment FROM square_tip_checkouts WHERE quote_reference=?').bind(authorized.fare.reference).first();
  return json({reference:authorized.fare.reference,environment:authorized.fare.environment,tip:row?{amount:row.amount_cents/100,status:row.status}:null});
 }catch{return json({error:'Optional tip unavailable.'},503);}
}
export async function onRequestPost({request,env}){
 if(!sameOrigin(request))return json({error:'Request rejected.'},403);
 if(!env.DB)return json({error:'Optional tips unavailable.'},503);
 if(!(request.headers.get('content-type')||'').includes('application/json'))return json({error:'JSON required.'},415);
 let body;try{const raw=await request.text();if(raw.length>2048)return json({error:'Request too large.'},413);body=JSON.parse(raw);}catch{return json({error:'Invalid request.'},400);}
 try{
  const authorized=await authorizedReceipt(env,body?.reference,body?.token);if(!authorized)return json({error:'A completed ride and verified full fare payment are required.'},409);
  if(body.action==='check'){
   const row=await env.DB.prepare('SELECT * FROM square_tip_checkouts WHERE quote_reference=?').bind(body.reference).first();if(row)await reconcileTip(env,row);
   const latest=await env.DB.prepare('SELECT status,amount_cents FROM square_tip_checkouts WHERE quote_reference=?').bind(body.reference).first();
   return json({status:latest?.status||'none',amount:latest?latest.amount_cents/100:null});
  }
  if(body.action!=='checkout')return json({error:'Choose a valid optional-tip action.'},400);
  return json(await prepareTipCheckout(env,body.reference,body.amount));
 }catch(error){return json({error:error.status?error.message:'Optional tip checkout is temporarily unavailable. You can retry safely.'},error.status||503);}
}
