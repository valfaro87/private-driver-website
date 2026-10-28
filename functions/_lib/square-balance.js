import { squareConfig } from './square.js';

export const isInvoiceBalance = record => record?.payment_type === 'balance' &&
  record.checkout_key?.startsWith('mvbri-invoice-balance-');

function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}

export function validInvoiceUrl(value, mode) {
  try {
    const url = new URL(value);
    const hosts = mode === 'sandbox' ? ['squareupsandbox.com', 'www.squareupsandbox.com'] :
      ['squareup.com', 'www.squareup.com'];
    return url.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.hostname) &&
      (url.pathname.startsWith('/pay-invoice/') || url.pathname.startsWith('/u/'));
  } catch { return false; }
}

async function square(env, path, body) {
  const config = squareConfig(env);
  if (!config) fail('Square payment collection is not configured.', 503);
  const response = await fetch(config.origin + '/v2/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json', 'Square-Version': '2026-09-16' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok) fail('Square could not prepare or verify this balance. Please retry safely.', 502);
  return data;
}

function providerId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,192}$/.test(value)) {
    fail('The saved Square invoice requires owner review.');
  }
  return encodeURIComponent(value);
}

async function ledger(env, paymentId) {
  return env.DB.prepare('SELECT * FROM square_balance_invoices WHERE payment_id = ?').bind(paymentId).first();
}

function checkInvoice(invoice, record, entry, env) {
  const requests = invoice?.payment_requests;
  if (!invoice?.id || (entry.square_invoice_id && invoice.id !== entry.square_invoice_id) ||
      invoice.order_id !== record.square_order_id || invoice.location_id !== env.SQUARE_LOCATION_ID ||
      invoice.primary_recipient?.customer_id !== entry.square_customer_id || requests?.length !== 1 ||
      requests[0].computed_amount_money?.amount !== record.amount_cents ||
      requests[0].computed_amount_money?.currency !== 'USD') {
    fail('The Square invoice no longer matches this ride. Please contact MVBRI.');
  }
}

export async function prepareBalanceInvoice(env, quote, method = 'online') {
  const config = squareConfig(env);
  if (!config || !env.DB) fail('Secure balance collection is not configured.', 503);
  if (!['online', 'reader'].includes(method)) fail('Choose a valid balance payment method.', 400);
  if (quote.status !== 'accepted' || quote.booking_status !== 'completed' ||
      !Number.isSafeInteger(quote.final_fare_cents) || quote.final_fare_cents < 2) {
    fail('An accepted quote and completed ride are required before collecting the remaining balance.');
  }
  const deposit = Math.round(quote.final_fare_cents / 2);
  const paid = await env.DB.prepare(`SELECT status, amount_cents, square_environment FROM square_payments
    WHERE quote_reference = ? AND payment_type = 'deposit'`).bind(quote.reference).first();
  if (paid?.status !== 'paid' || paid.amount_cents !== deposit || paid.square_environment !== config.mode) {
    fail('The 50% deposit must be verified before collecting the remaining balance.');
  }
  const amount = quote.final_fare_cents - paid.amount_cents;
  const now = new Date().toISOString();
  const key = 'mvbri-invoice-balance-' + quote.reference;
  const email = String(quote.customer_email || '').trim();
  const name = String(quote.customer_name || '').trim();
  if (!name || name.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    fail('The owner must verify the booking name and email before preparing its balance invoice.');
  }
  const workflow = {
    kind: 'mvbri-balance-invoice-v1', locationId: env.SQUARE_LOCATION_ID, amount,
    dueDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    customer: { idempotency_key: 'mvbri-bal-' + quote.reference + '-customer',
      given_name: name, email_address: email, reference_id: quote.reference }
  };
  await env.DB.prepare(`INSERT OR IGNORE INTO square_payments
    (quote_reference,booking_reference,payment_type,amount_cents,currency,status,square_environment,
     checkout_key,checkout_request,created_at,updated_at) VALUES (?,?,'balance',?,'USD','pending',?,?,?,?,?)`)
    .bind(quote.reference,quote.booking_reference,amount,config.mode,key,JSON.stringify(workflow),now,now).run();
  const load = () => env.DB.prepare(`SELECT * FROM square_payments WHERE quote_reference = ? AND payment_type = 'balance'`)
    .bind(quote.reference).first();
  let record = await load();
  if (!record || !isInvoiceBalance(record) || record.checkout_key !== key || record.amount_cents !== amount ||
      record.square_environment !== config.mode || record.currency !== 'USD') {
    fail('This ride already has a different balance checkout. Use its existing online link or contact MVBRI.');
  }
  if (record.status !== 'pending') fail(record.status === 'paid' ? 'This balance is already paid.' :
    'This balance requires owner review.');
  const saved = JSON.parse(record.checkout_request || '{}');
  if (saved.kind !== workflow.kind || saved.locationId !== env.SQUARE_LOCATION_ID || saved.amount !== amount ||
      !/^\d{4}-\d{2}-\d{2}$/.test(saved.dueDate) ||
      saved.customer?.idempotency_key !== workflow.customer.idempotency_key ||
      saved.customer.reference_id !== quote.reference || !saved.customer.given_name || !saved.customer.email_address) {
    fail('The saved balance request requires owner verification.');
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO square_balance_invoices (payment_id,created_at,updated_at)
    VALUES (?,?,?)`).bind(record.id,now,now).run();
  let entry = await ledger(env,record.id);
  if (entry.review_required) fail('This balance requires owner review before payment.');

  if (!entry.square_customer_id) {
    const {customer} = await square(env,'customers',saved.customer);
    if (!customer?.id) fail('Square could not prepare this balance customer.',502);
    await env.DB.prepare(`UPDATE square_balance_invoices SET square_customer_id=?,updated_at=?
      WHERE payment_id=? AND square_customer_id IS NULL`).bind(customer.id,now,record.id).run();
    entry = await ledger(env,record.id);
    if (entry.square_customer_id !== customer.id) fail('The balance customer changed. Please contact MVBRI.');
  }
  if (!record.square_order_id) {
    const {order} = await square(env,'orders', { idempotency_key: key + '-order', order: {
      location_id: saved.locationId, customer_id: entry.square_customer_id,
      reference_id: quote.reference + '-balance',
      line_items: [{ name: 'MVBRI Ride Balance', quantity: '1', base_price_money: {amount,currency:'USD'} }],
      pricing_options: {auto_apply_discounts:false,auto_apply_taxes:false}
    }});
    if (!order?.id || order.location_id !== saved.locationId || order.total_money?.amount !== amount ||
        order.total_money?.currency !== 'USD' || order.state !== 'OPEN') {
      fail('Square returned a different balance amount. No payment has been requested.',502);
    }
    await env.DB.prepare(`UPDATE square_payments SET square_order_id=?,updated_at=? WHERE id=? AND status='pending'
      AND square_order_id IS NULL`).bind(order.id,now,record.id).run();
    record = await load();
    if (record.square_order_id !== order.id) fail('The balance order changed. Please contact MVBRI.');
  }
  let invoice;
  if (!entry.square_invoice_id) {
    ({invoice} = await square(env,'invoices', {idempotency_key:key+'-invoice', invoice: {
      location_id: saved.locationId, order_id: record.square_order_id,
      primary_recipient: {customer_id:entry.square_customer_id},
      payment_requests: [{request_type:'BALANCE',due_date:saved.dueDate,
        automatic_payment_source:'NONE',tipping_enabled:false}],
      delivery_method:'SHARE_MANUALLY', store_payment_method_enabled:false,
      accepted_payment_methods: {card:true,cash_app_pay:config.mode==='production',
        bank_account:false,square_gift_card:false,buy_now_pay_later:false},
      invoice_number:quote.reference+'-BAL', title:'MVBRI Ride Balance',
      description:'Remaining ride fare after your verified 50% deposit.'
    }}));
    checkInvoice(invoice,record,entry,env);
    await env.DB.prepare(`UPDATE square_balance_invoices SET square_invoice_id=?,updated_at=?
      WHERE payment_id=? AND square_invoice_id IS NULL`).bind(invoice.id,now,record.id).run();
    entry = await ledger(env,record.id);
    if (entry.square_invoice_id !== invoice.id) fail('The balance invoice changed. Please contact MVBRI.');
  } else {
    ({invoice} = await square(env,'invoices/'+providerId(entry.square_invoice_id)));
  }
  checkInvoice(invoice,record,entry,env);
  if (invoice.status === 'DRAFT') {
    // Publishing makes the single invoice payable. SHARE_MANUALLY sends no email,
    // SMS, reminders or automatic card charges.
    ({invoice} = await square(env,'invoices/'+providerId(invoice.id)+'/publish', {
      idempotency_key:key+'-publish', version:invoice.version
    }));
    checkInvoice(invoice,record,entry,env);
  }
  if (!['UNPAID','PARTIALLY_PAID'].includes(invoice.status)) {
    await reconcileBalanceInvoice(env,record);
    fail(invoice.status === 'PAID' ? 'Square has already received payment. Check payment status.' :
      'Square is processing or reviewing this invoice. Check payment status before paying again.');
  }
  if (invoice.status === 'PARTIALLY_PAID') {
    await reconcileBalanceInvoice(env,record);
    entry = await ledger(env,record.id);
    if (entry.review_required) fail('This invoice needs owner verification before another payment.');
  }
  if (!validInvoiceUrl(invoice.public_url,config.mode)) fail('Square returned an invalid invoice payment link.',502);
  await env.DB.batch([
    env.DB.prepare(`UPDATE square_payments SET checkout_url=?,updated_at=? WHERE id=? AND status='pending'`)
      .bind(invoice.public_url,now,record.id),
    env.DB.prepare(`UPDATE square_balance_invoices SET invoice_status=?,preferred_method=?,updated_at=? WHERE payment_id=?`)
      .bind(invoice.status,method,now,record.id)
  ]);
  const latest = await load();
  if (latest.status !== 'pending') fail('Payment status changed. Refresh the quote before paying.');
  return {checkoutUrl:invoice.public_url,invoiceNumber:quote.reference+'-BAL',amount:(amount-entry.verified_amount_cents)/100,
    environment:config.mode,inPerson:method==='reader'};
}

export async function reconcileBalanceInvoice(env, record) {
  const config = squareConfig(env);
  if (!config || !isInvoiceBalance(record) || record.square_environment !== config.mode ||
      !record.square_order_id || record.currency !== 'USD') return 0;
  const entry = await ledger(env,record.id);
  if (!entry?.square_invoice_id || !entry.square_customer_id) return 0;
  const {invoice} = await square(env,'invoices/'+providerId(entry.square_invoice_id));
  checkInvoice(invoice,record,entry,env);
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE square_balance_invoices SET invoice_status=?,updated_at=? WHERE payment_id=?`)
    .bind(invoice.status,now,record.id).run();
  const {order} = await square(env,'orders/'+providerId(record.square_order_id));
  if (order?.id !== record.square_order_id || order.location_id !== env.SQUARE_LOCATION_ID ||
      order.reference_id !== record.quote_reference+'-balance' || order.total_money?.amount !== record.amount_cents ||
      order.total_money?.currency !== 'USD') fail('The invoice order requires owner review.');
  const ids = [...new Set((order.tenders || []).map(t=>t.payment_id || t.id).filter(Boolean))];
  if (ids.length > 20) fail('This invoice has too many payments for automatic verification.');
  const verified = [];
  let total = 0, review = false, refunded = false;
  for (const id of ids) {
    const {payment} = await square(env,'payments/'+providerId(id));
    if (payment?.id !== id || payment.order_id !== record.square_order_id ||
        payment.location_id !== env.SQUARE_LOCATION_ID || payment.status !== 'COMPLETED' ||
        !['CARD','WALLET'].includes(payment.source_type) || payment.amount_money?.currency !== 'USD' ||
        !Number.isSafeInteger(payment.amount_money.amount) || payment.amount_money.amount <= 0) continue;
    if ((payment.refunded_money?.amount || 0) > 0) {refunded=true;review=true;continue;}
    total += payment.amount_money.amount;
    verified.push(id);
  }
  if (total > record.amount_cents || ['CANCELED','REFUNDED','PARTIALLY_REFUNDED','FAILED'].includes(invoice.status)) review=true;
  if (invoice.status === 'PARTIALLY_PAID' &&
      invoice.payment_requests[0].total_completed_amount_money?.amount !== total) review=true;
  if (invoice.status === 'PAID' && (order.state !== 'COMPLETED' || total !== record.amount_cents ||
      invoice.payment_requests[0].total_completed_amount_money?.amount !== record.amount_cents ||
      invoice.payment_requests[0].total_completed_amount_money?.currency !== 'USD')) review=true;
  await env.DB.prepare(`UPDATE square_balance_invoices SET verified_payment_ids=?,verified_amount_cents=?,review_required=?,updated_at=?
    WHERE payment_id=?`).bind(JSON.stringify(verified),Math.min(total,record.amount_cents),review?1:0,now,record.id).run();
  if (refunded) {
    await env.DB.prepare(`UPDATE square_payments SET status='refunded',updated_at=? WHERE id=?`)
      .bind(now,record.id).run();
    return 0;
  }
  if (review || invoice.status !== 'PAID' || order.state !== 'COMPLETED' || total !== record.amount_cents ||
      invoice.payment_requests[0].total_completed_amount_money?.amount !== record.amount_cents ||
      invoice.payment_requests[0].total_completed_amount_money?.currency !== 'USD') return 0;
  const result = await env.DB.prepare(`UPDATE square_payments SET status='paid',square_payment_id=?,paid_at=?,updated_at=?
    WHERE id=? AND status='pending' AND square_environment=? AND amount_cents=? AND currency='USD'`)
    .bind(verified[0],now,now,record.id,config.mode,record.amount_cents).run();
  return result.meta?.changes || 0;
}
