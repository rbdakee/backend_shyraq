import { randomBytes } from 'node:crypto';
import { BccCheckoutSession } from './bcc-checkout-store.port';

export interface BccCheckoutPage {
  html: string;
  contentSecurityPolicy: string;
}

export function renderBccCheckoutPage(
  session: BccCheckoutSession,
  clientIp: string,
): BccCheckoutPage {
  const gateway = new URL(session.gatewayUrl);
  const nonce = randomBytes(18).toString('base64');
  const fields = {
    ...session.formFields,
    CLIENT_IP: clientIp,
  };
  const inputs = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `form-action ${gateway.origin}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "img-src 'none'",
    "style-src 'none'",
    "connect-src 'none'",
  ].join('; ');

  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BCC checkout</title>
</head>
<body>
  <form id="bcc-checkout" method="post" action="${escapeHtml(session.gatewayUrl)}" enctype="application/x-www-form-urlencoded">
    ${inputs}
    <span id="billing-details" hidden data-phone="${escapeHtml(session.billingPhone)}" data-address="${escapeHtml(session.billingAddress)}"></span>
    <noscript>Для продолжения оплаты включите JavaScript.</noscript>
  </form>
  <script nonce="${nonce}">
    (() => {
      const details = document.getElementById('billing-details');
      const phone = details.dataset.phone.replace(/\\D/g, '');
      const payload = {
        browserScreenHeight: String(window.outerHeight || window.screen.height || 0),
        browserScreenWidth: String(window.outerWidth || window.screen.width || 0),
        mobilePhone: { cc: phone.slice(0, 1), subscriber: phone.slice(1) },
        billAddrLine1: details.dataset.address
      };
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'M_INFO';
      input.value = btoa(binary);
      const form = document.getElementById('bcc-checkout');
      form.appendChild(input);
      form.submit();
    })();
  </script>
</body>
</html>`;
  return { html, contentSecurityPolicy };
}

export function renderBccReturnPage(): BccCheckoutPage {
  const nonce = randomBytes(18).toString('base64');
  return {
    html: `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Платёж обрабатывается</title>
</head>
<body>
  <p>Платёж обрабатывается. Вернитесь в приложение, чтобы проверить статус.</p>
  <script nonce="${nonce}">document.documentElement.dataset.paymentStatus = 'processing';</script>
</body>
</html>`,
    contentSecurityPolicy: [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join('; '),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
