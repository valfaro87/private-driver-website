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
  const config = squareConfig(env);
  if (!config || quote.status !== 'accepted') return { enabled: false };
  const booking = await env.DB.prepare('SELECT status FROM bookings WHERE reference = ?')
    .bind(quote.booking_reference).first();
  if (!booking || ['cancelled', 'declined'].includes(booking.status)) return { enabled: false };
  const records = (await env.DB.prepare(`SELECT payment_type, status, square_environment
    FROM square_payments WHERE quote_reference = ?`).bind(quote.reference).all()).results || [];
  // Never confuse a simulated payment with a real payment.
  if (records.some(r => r.square_environment !== config.mode)) return { enabled: false };
  const depositPaid = records.some(r => r.payment_type === 'deposit' && r.status === 'paid');
  const balancePaid = records.some(r => r.payment_type === 'balance' && r.status === 'paid');
  const deposit = Math.round(quote.final_fare_cents / 2);
  return { enabled: true, environment: config.mode, methods: config.methods,
    depositPaid, balancePaid, deposit: deposit / 100,
    balance: (quote.final_fare_cents - deposit) / 100,
    canPayDeposit: !depositPaid && !records.some(r => r.payment_type === 'deposit' && r.status !== 'pending'),
    canPayBalance: depositPaid && booking.status === 'completed' && !balancePaid &&
      !records.some(r => r.payment_type === 'balance' && r.status !== 'pending') };
}
