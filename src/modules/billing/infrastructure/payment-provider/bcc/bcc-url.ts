import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';

/**
 * Builds a server-owned public BCC URL. HTTPS URLs always retain an explicit
 * `:443` because BCC requires the port in NOTIFY_URL and the project uses the
 * same fixed origin for BACKREF and the checkout bridge.
 */
export function buildBccBackendUrl(
  config: ConfigService<AllConfigType>,
  route: string,
): string {
  if (route.startsWith('/') || route.includes('..')) {
    throw new Error('bcc_backend_route_invalid');
  }
  const origin = config.getOrThrow('app.backendDomain', { infer: true });
  const prefix = config.getOrThrow('app.apiPrefix', { infer: true });
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  const url = new URL(`${prefix.replace(/^\/|\/$/g, '')}/v1/${route}`, base);

  if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('bcc_public_url_must_use_https');
  }
  if (url.protocol === 'https:' && url.port === '') {
    const authority = `${url.protocol}//${url.host}`;
    return url.toString().replace(authority, `${authority}:443`);
  }
  return url.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}
