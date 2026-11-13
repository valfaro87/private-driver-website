export const isPayPalPayment = record => record?.checkout_key?.startsWith('mvbri-paypal-');

export function isPayPalSandboxQuote(env, reference) {
  return !!reference && reference === env.PAYPAL_SANDBOX_TEST_QUOTE;
}

export function paypalConfig(env, reference) {
  const mode = env.PAYPAL_ENVIRONMENT;
  const testQuote = isPayPalSandboxQuote(env, reference);
  const enabled = testQuote ? mode === 'sandbox' :
    mode === 'production' && env.PAYPAL_LIVE_PAYMENTS_APPROVED === 'true';
  if (!enabled || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return null;
  return { mode, clientId: env.PAYPAL_CLIENT_ID,
    origin: mode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com' };
}

export function fareEnvironment(env, reference, square) {
  if (isPayPalSandboxQuote(env, reference)) return 'sandbox';
  return square?.mode || paypalConfig(env, reference)?.mode;
}
