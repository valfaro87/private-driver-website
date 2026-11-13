import { fareEnvironment, isPayPalPayment, isPayPalSandboxQuote, paypalConfig } from './paypal-config.js';

export function squareConfig(env) {
  const mode = env.SQUARE_ENVIRONMENT;
  if (!['sandbox', 'production'].includes(mode) ||
      (mode === 'production' && env.SQUARE_LIVE_PAYMENTS_APPROVED !== 'true') ||
      !env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return null;
  return {
    mode,
    origin: mode === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com',
    methods: mode === 'sandbox' ? ['Credit / debit test card'] :
      ['Credit / debit card', 'Apple Pay', 'Google Pay', 'Cash App Pay']
  };
}

export function validCheckoutUrl(value, mode) {
  try {
    const url = new URL(value);
    const allowed = mode === 'sandbox'
      ? ['sandbox.square.link', 'checkout.squareupsandbox.com', 'connect.squareupsandbox.com']
      : ['square.link', 'checkout.square.site', 'checkout.squareup.com', 'connect.squareup.com'];
    return url.protocol === 'https:' && !url.username && !url.password && allowed.includes(url.hostname);
  } catch { return false; }
}

export async function paymentSummary(env, quote) {
  const square = squareConfig(env);
  const paypal = paypalConfig(env, quote.reference);
  const environment = fareEnvironment(env, quote.reference, square);
  const squareAvailable = !!square && !isPayPalSandboxQuote(env, quote.reference);
  const paypalAvailable = !!paypal && paypal.mode === environment;
  if (!environment || quote.status !== 'accepted') return { enabled: false };
  const booking = await env.DB.prepare('SELECT status FROM bookings WHERE reference = ?')
    .bind(quote.booking_reference).first();
  if (!booking || ['cancelled', 'declined'].includes(booking.status)) return { enabled: false };
  const records = (await env.DB.prepare(`SELECT id, payment_type, status, square_environment, checkout_key
    FROM square_payments WHERE quote_reference = ?`).bind(quote.reference).all()).results || [];
  // Never confuse a simulated payment with a real payment.
  if (records.some(r => r.square_environment !== environment)) return { enabled: false };
  const depositRecord = records.find(r => r.payment_type === 'deposit');
  const depositPaid = depositRecord?.status === 'paid';
  const balanceRecordedPaid = records.some(r => r.payment_type === 'balance' && r.status === 'paid');
  const balanceRecord = records.find(r => r.payment_type === 'balance');
  const invoiceBalance = balanceRecord?.checkout_key?.startsWith('mvbri-invoice-balance-');
  const invoice = invoiceBalance ? await env.DB.prepare(`SELECT square_invoice_id,invoice_status,preferred_method,review_required,verified_amount_cents
    FROM square_balance_invoices WHERE payment_id=?`).bind(balanceRecord.id).first() : null;
  const deposit = Math.round(quote.final_fare_cents / 2);
  const balancePaid = balanceRecordedPaid && !invoice?.review_required;
  const canPayBalance = depositPaid && booking.status === 'completed' && !balancePaid &&
    !records.some(r => r.payment_type === 'balance' && r.status !== 'pending') &&
    !invoice?.review_required && invoice?.invoice_status !== 'PAYMENT_PENDING';
  const depositViaPayPal = isPayPalPayment(depositRecord);
  const balanceViaPayPal = isPayPalPayment(balanceRecord);
  const canPayDeposit = !depositPaid && (!depositRecord || depositRecord.status === 'pending');
  const paypalPending = [depositRecord, balanceRecord].find(row => isPayPalPayment(row) && row.status === 'pending');
  const paypalCheckout = paypalPending && await env.DB.prepare(
    'SELECT method, capture_started_at FROM paypal_checkouts WHERE payment_id = ?'
  ).bind(paypalPending.id).first();
  const paypalType = canPayDeposit && (!depositRecord || depositViaPayPal) ? 'deposit' :
    canPayBalance && (!balanceRecord || balanceViaPayPal) ? 'balance' : null;
  return { enabled: true, environment, methods: squareAvailable ? square.methods : [], squareAvailable,
    depositPaid, balancePaid, deposit: deposit / 100,
    balance: balancePaid ? 0 : Math.max(0,quote.final_fare_cents - deposit - (invoice?.verified_amount_cents || 0)) / 100,
    canPayDeposit: squareAvailable && canPayDeposit && !depositViaPayPal,
    canPayBalance: squareAvailable && canPayBalance && !balanceViaPayPal,
    canPayInPerson: squareAvailable && canPayBalance && (!balanceRecord || !!invoiceBalance),
    balanceMethod: invoice?.preferred_method || 'online',
    balanceInvoiceReady: !!invoice?.square_invoice_id,
    balanceProcessing: invoice?.invoice_status === 'PAYMENT_PENDING' ||
      (paypalPending?.payment_type === 'balance' && !!paypalCheckout?.capture_started_at),
    balanceNeedsReview: !!invoice?.review_required || ['refunded','failed'].includes(balanceRecord?.status),
    balanceViaPayPal,
    ...(paypalAvailable && paypalType && !paypalCheckout?.capture_started_at ? {
      paypal: { clientId: paypal.clientId, paymentType: paypalType,
        method: paypalCheckout?.method, checkoutKey: paypalCheckout ? paypalPending.checkout_key : undefined }
    } : {})
  };
}
