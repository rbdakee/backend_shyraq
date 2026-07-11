import {
  renderBccCheckoutPage,
  renderBccReturnPage,
} from './bcc-checkout-html';
import { BccCheckoutSession } from './bcc-checkout-store.port';

function session(): BccCheckoutSession {
  return {
    paymentId: '00000000-0000-4000-8000-000000000001',
    kindergartenId: '00000000-0000-4000-8000-000000000002',
    order: '12345678901234567890',
    gatewayUrl: 'https://test3ds.bcc.kz:5445/cgi-bin/cgi_link',
    formFields: {
      TRTYPE: '1',
      ORDER: '12345678901234567890',
      DESC: '"><img src=x onerror=alert(1)>',
      P_SIGN: 'ABC123',
    },
    billingPhone: '+77011234567',
    billingAddress: 'Алматы <script>alert(1)</script>',
  };
}

describe('BCC checkout HTML', () => {
  it('renders an escaped POST form with strict no-exfiltration CSP', () => {
    const page = renderBccCheckoutPage(session(), '203.0.113.10');

    expect(page.html).toContain('method="post"');
    expect(page.html).toContain(
      'action="https://test3ds.bcc.kz:5445/cgi-bin/cgi_link"',
    );
    expect(page.html).toContain('name="CLIENT_IP" value="203.0.113.10"');
    expect(page.html).toContain('browserScreenHeight');
    expect(page.html).toContain('browserScreenWidth');
    expect(page.html).toContain("input.name = 'M_INFO'");
    expect(page.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.html).not.toContain('<img src=x');
    expect(page.html).not.toMatch(/name="(?:CARD|EXP|CVC2)"/);
    expect(page.contentSecurityPolicy).toContain(
      'form-action https://test3ds.bcc.kz:5445',
    );
    expect(page.contentSecurityPolicy).toContain("default-src 'none'");
    expect(page.contentSecurityPolicy).toContain("frame-ancestors 'none'");
  });

  it('renders a neutral return page that only says processing', () => {
    const page = renderBccReturnPage();

    expect(page.html).toContain('processing');
    expect(page.html).not.toContain('success');
    expect(page.contentSecurityPolicy).toContain("form-action 'none'");
  });
});
