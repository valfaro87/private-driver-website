let sdk;

function loadSdk(environment, clientId) {
  if (!sdk) {
    sdk = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = (environment === 'sandbox' ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com') +
        '/web-sdk/v6/core';
      script.referrerPolicy = 'no-referrer';
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        reject(new Error('Unable to load PayPal checkout.'));
      };
      document.head.append(script);
    }).then(async () => {
      const instance = await window.paypal.createInstance({
        clientId, components: ['paypal-payments', 'venmo-payments'], pageType: 'checkout'
      });
      return { instance, eligible: await instance.findEligibleMethods({ currencyCode: 'USD' }) };
    }).catch(error => {
      sdk = undefined;
      throw error;
    });
  }
  return sdk;
}

export async function renderPayPal(container, payment, token, refresh, showStatus, setBusy) {
  container.replaceChildren();
  container.hidden = true;
  const config = payment?.paypal;
  if (!config) return;

  const controls = document.createElement('div');
  controls.className = 'wallet-controls';
  container.append(controls);
  const call = async (action, extra = {}) => {
    const response = await fetch('/api/paypal-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action, paymentType: config.paymentType, ...extra })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'PayPal checkout is unavailable.');
    return data;
  };

  const cancel = async checkoutKey => {
    await call('cancel', { checkoutKey });
    await refresh();
    showStatus('Checkout canceled. You can choose a payment method again.');
  };
  if (config.checkoutKey) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Cancel PayPal or Venmo checkout';
    button.addEventListener('click', async () => {
      if (!setBusy(true)) return;
      try { await cancel(config.checkoutKey); }
      catch (error) { showStatus(error.message); }
      finally { setBusy(false); }
    });
    controls.append(button);
    container.hidden = false;
  }

  try {
    const { instance, eligible } = await loadSdk(payment.environment, config.clientId);
    if (!controls.isConnected) return;
    for (const method of ['paypal', 'venmo']) {
      if (!eligible.isEligible(method) || (config.method && config.method !== method)) continue;
      const createSession = method === 'paypal' ? instance.createPayPalOneTimePaymentSession :
        instance.createVenmoOneTimePaymentSession;
      let callbackRunning = false;
      let checkoutKey;
      const session = createSession.call(instance, {
        async onApprove({ orderId }) {
          callbackRunning = true;
          try {
            const result = await call('capture', { orderId });
            await refresh();
            showStatus(result.paid ? 'Your payment is verified.' : 'Payment is pending. Check payment status before trying again.');
          } catch (error) {
            await refresh();
            showStatus(error.message);
          } finally { setBusy(false); }
        },
        async onCancel() {
          callbackRunning = true;
          try { await cancel(checkoutKey); }
          catch (error) { showStatus(error.message); }
          finally { setBusy(false); }
        },
        async onError() {
          callbackRunning = true;
          await refresh();
          showStatus('Checkout paused. Check payment status before starting another payment.');
          setBusy(false);
        }
      });
      const button = document.createElement(method + '-button');
      button.setAttribute('type', 'pay');
      button.addEventListener('click', async () => {
        if (!setBusy(true)) return;
        callbackRunning = false;
        checkoutKey = config.checkoutKey;
        try {
          const prepared = call('create', { method }).then(data => {
            checkoutKey = data.checkoutKey;
            return { orderId: data.orderId };
          });
          await session.start({ presentationMode: 'auto' }, prepared);
        } catch (error) {
          if (!callbackRunning) {
            await refresh();
            showStatus(error.message || 'Unable to start checkout.');
            setBusy(false);
          }
        }
      });
      controls.append(button);
      container.hidden = false;
    }
  } catch {
    if (controls.isConnected && !payment.squareAvailable) {
      showStatus('PayPal and Venmo checkout is unavailable in this browser. Please reload the quote to try again.');
    }
  }
}
