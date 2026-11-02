import {squareConfig} from './square.js';
import {isInvoiceBalance,reconcileBalanceInvoice} from './square-balance.js';
export async function verifyQuotePayments(env,quote){
 const config=squareConfig(env);if(!config)return 0;
  const rows=(await env.DB.prepare(`SELECT * FROM square_payments WHERE quote_reference=?
      AND (status='pending' OR (payment_type='balance' AND checkout_key LIKE 'mvbri-invoice-balance-%'))
      LIMIT 2`).bind(quote.reference).all()).results || [];
    const headers={Authorization:`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Square-Version':'2026-09-16'};
    const get=async(resource,id)=>{
      if(typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,192}$/.test(id))throw new Error('Invalid provider identifier.');
      const response=await fetch(config.origin+'/v2/'+resource+'/'+encodeURIComponent(id),{headers,signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('Provider lookup failed.');
      return response.json();
    };
    let verified=0;
    for(const record of rows) {
      if(record.square_environment!==config.mode || !record.square_order_id || record.currency!=='USD')continue;
      const deposit=Math.round(quote.final_fare_cents/2);
      const expected=record.payment_type==='deposit'?deposit:quote.final_fare_cents-deposit;
      if(record.amount_cents!==expected)continue;
      if(isInvoiceBalance(record)) {
        verified+=await reconcileBalanceInvoice(env,record);
        continue;
      }
      const {order}=await get('orders',record.square_order_id);
      if(order?.id!==record.square_order_id || order.location_id!==env.SQUARE_LOCATION_ID)continue;
      for(const tender of (order.tenders || []).slice(0,10)) {
        const paymentId=tender.payment_id || tender.id;
        if(!paymentId)continue;
        const {payment}=await get('payments',paymentId);
        if(payment?.id!==paymentId || payment.status!=='COMPLETED' ||
          payment.location_id!==env.SQUARE_LOCATION_ID || payment.order_id!==record.square_order_id ||
          !Number.isSafeInteger(payment.amount_money?.amount) || payment.amount_money.amount!==expected ||
          payment.amount_money.currency!=='USD' || (payment.refunded_money?.amount||0)>0)continue;
        const now=new Date().toISOString();
        const updated=await env.DB.prepare(`UPDATE square_payments SET status='paid',square_payment_id=?,paid_at=?,updated_at=?
          WHERE id=? AND status='pending' AND square_order_id=? AND amount_cents=? AND currency='USD' AND square_environment=?`)
          .bind(payment.id,now,now,record.id,record.square_order_id,expected,config.mode).run();
        verified+=updated.meta?.changes || 0;
        break;
      }
    }
 return verified;
}
