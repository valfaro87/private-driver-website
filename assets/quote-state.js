// Only an issued quote with a valid future deadline may show response controls.
export function quoteState(quote, now = Date.now()) {
  let status = quote?.status || '';
  const deadline = Date.parse(quote?.expiresAt);
  if (status === 'issued' && (!Number.isFinite(deadline) || deadline <= now)) {
    status = 'expired';
  }
  const messages = {
    issued: 'Please review the details before responding.',
    accepted: 'This quote has already been accepted.',
    declined: 'This quote has been declined.',
    expired: 'This quote has expired. Please contact MVBRI for an updated quote.',
    cancelled: 'This quote is no longer active. Please contact MVBRI.',
    superseded: 'This quote is no longer active. Please contact MVBRI.'
  };
  return {
    status,
    canRespond: status === 'issued',
    canPay: status === 'accepted',
    message: messages[status] || 'This quote is not available for a customer response.'
  };
}
