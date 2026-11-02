import {squareConfig,validCheckoutUrl} from './square.js';
const problem=(message,status=409)=>Object.assign(new Error(message),{status});
export async function prepareTipCheckout(env,reference,amount){
 const config=squareConfig(env);if(!config)throw problem('Optional tips are not available yet.',503);
 const cents=Math.round(amount*100);
 if(typeof amount!=='number'||!Number.isFinite(amount)||Math.abs(amount*100-cents)>0.000001||cents<100||cents>50000)throw problem('Choose an optional tip between $1 and $500, with no more than two decimal places.',400);
 const time=new Date().toISOString(),key='mvbri-tip-v1-'+reference;
 const payload=JSON.stringify({idempotency_key:key,quick_pay:{name:'MVBRI Optional Gratuity',price_money:{amount:cents,currency:'USD'},location_id:env.SQUARE_LOCATION_ID},checkout_options:{allow_tipping:false,ask_for_shipping_address:false,accepted_payment_methods:{apple_pay:config.mode==='production',google_pay:config.mode==='production',cash_app_pay:config.mode==='production',afterpay_clearpay:false}}});
 await env.DB.prepare(`INSERT OR IGNORE INTO square_tip_checkouts(quote_reference,amount_cents,square_environment,checkout_key,checkout_request,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(reference,cents,config.mode,key,payload,time,time).run();
 const load=()=>env.DB.prepare('SELECT * FROM square_tip_checkouts WHERE quote_reference=?').bind(reference).first();
 const row=await load();
 if(row?.status==='paid')throw problem('Your optional tip is already verified. Thank you.');
 if(!row||row.amount_cents!==cents||row.square_environment!==config.mode||row.currency!=='USD'||row.status!=='pending')throw problem('An earlier tip checkout already exists. Use its saved amount and link; a second tip will not be created.');
 if(row.checkout_url){if(!row.square_order_id||!row.square_payment_link_id||!validCheckoutUrl(row.checkout_url,config.mode))throw problem('This tip checkout needs owner review.');return {checkoutUrl:row.checkout_url,amount:cents/100,environment:config.mode};}
 const saved=JSON.parse(row.checkout_request);
 if(saved.idempotency_key!==row.checkout_key||saved.quick_pay?.location_id!==env.SQUARE_LOCATION_ID||saved.quick_pay?.price_money?.amount!==cents||saved.quick_pay?.price_money?.currency!=='USD'||row.square_order_id||row.square_payment_link_id)throw problem('This tip checkout needs owner review.');
 const response=await fetch(config.origin+'/v2/online-checkout/payment-links',{method:'POST',headers:{Authorization:'Bearer '+env.SQUARE_ACCESS_TOKEN,'Content-Type':'application/json','Square-Version':'2026-09-16'},body:row.checkout_request,signal:AbortSignal.timeout(15000)});
 const data=await response.json(),link=data.payment_link;
 if(!response.ok||!link?.id||!link.order_id||!validCheckoutUrl(link.url,config.mode))throw problem('Optional tip checkout is temporarily unavailable. You can retry safely.',502);
 await env.DB.prepare(`UPDATE square_tip_checkouts SET square_order_id=?,square_payment_link_id=?,checkout_url=?,updated_at=? WHERE quote_reference=? AND status='pending' AND square_order_id IS NULL AND square_payment_link_id IS NULL AND checkout_url IS NULL`).bind(link.order_id,link.id,link.url,new Date().toISOString(),reference).run();
 const latest=await load();if(latest.status!=='pending'||latest.square_order_id!==link.order_id||latest.checkout_url!==link.url)throw problem('Tip status changed. Refresh before paying.');
 return {checkoutUrl:link.url,amount:cents/100,environment:config.mode};
}
export async function recordTipPayment(env,row,payment){
 const config=squareConfig(env);
 if(!config||row.square_environment!==config.mode||payment?.order_id!==row.square_order_id||payment.location_id!==env.SQUARE_LOCATION_ID||payment.status!=='COMPLETED'||payment.source_type==='EXTERNAL'||payment.amount_money?.currency!=='USD'||payment.amount_money.amount!==row.amount_cents||!payment.id)return 0;
 if((payment.refunded_money?.amount||0)>0){await env.DB.prepare(`UPDATE square_tip_checkouts SET status='refunded',updated_at=? WHERE quote_reference=?`).bind(new Date().toISOString(),row.quote_reference).run();return 0;}
 const time=new Date().toISOString();const result=await env.DB.prepare(`UPDATE square_tip_checkouts SET status='paid',square_payment_id=?,paid_at=?,updated_at=? WHERE quote_reference=? AND status='pending' AND square_order_id=? AND amount_cents=? AND square_environment=?`).bind(payment.id,time,time,row.quote_reference,payment.order_id,row.amount_cents,config.mode).run();
 return result.meta?.changes||0;
}
export async function reconcileTip(env,row){
 const config=squareConfig(env);if(!config||!row?.square_order_id||row.square_environment!==config.mode)return 0;
 const get=async(resource,id)=>{
  if(!/^[a-zA-Z0-9_-]{1,192}$/.test(id||''))throw new Error('Invalid payment identifier.');
  const response=await fetch(config.origin+'/v2/'+resource+'/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+env.SQUARE_ACCESS_TOKEN,'Square-Version':'2026-09-16'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Payment lookup unavailable.');return response.json();
 };
 const {order}=await get('orders',row.square_order_id);
 if(order?.id!==row.square_order_id||order.location_id!==env.SQUARE_LOCATION_ID)return 0;
 for(const tender of (order.tenders||[]).slice(0,10)){const id=tender.payment_id||tender.id;if(!id)continue;const {payment}=await get('payments',id);if(payment?.id!==id)continue;const changed=await recordTipPayment(env,row,payment);if(changed)return changed;}
 return 0;
}
