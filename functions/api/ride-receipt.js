import {json} from '../_lib/auth.js';
import {authorizedReceipt,receiptLinks} from '../_lib/postride.js';
import {customerOrigin} from '../_lib/communications.js';
export async function onRequestGet({request,env}){
 if(!env.DB)return json({error:'Receipt unavailable.'},503);
 const params=new URL(request.url).searchParams;
 try{
  const result=await authorizedReceipt(env,params.get('ref'),params.get('token'));
  if(!result)return json({error:'This private receipt is unavailable. Use the link sent after your completed ride and verified payment.'},404);
  const {fare,record}=result,tip=await env.DB.prepare(`SELECT amount_cents,status,paid_at FROM square_tip_checkouts WHERE quote_reference=?`).bind(fare.reference).first();
  return json({reference:fare.reference,bookingReference:fare.booking_reference,rideDate:fare.pickup_date,fare:fare.final_fare_cents/100,deposit:fare.depositCents/100,balancePaid:fare.balanceCents/100,paidAt:fare.paidAt,environment:fare.environment,tip:tip?{amount:tip.amount_cents/100,status:tip.status,paidAt:tip.paid_at}:null,...await receiptLinks(env,record,customerOrigin(env))});
 }catch{return json({error:'Receipt temporarily unavailable.'},503);}
}
