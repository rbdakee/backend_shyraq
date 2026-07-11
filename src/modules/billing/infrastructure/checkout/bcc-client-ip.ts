import { isIP } from 'node:net';
import type { Request } from 'express';

export function resolveBccClientIp(
  request: Pick<Request, 'headers' | 'socket'>,
  trustedProxyHops = readTrustedProxyHops(process.env.BCC_TRUSTED_PROXY_HOPS),
): string {
  const remote = normalizeIp(request.socket.remoteAddress);
  if (trustedProxyHops === 0) return remote;

  const forwarded = headerValue(request.headers['x-forwarded-for'])
    .split(',')
    .map((value) => normalizeIp(value))
    .filter((value) => isIP(value) !== 0);
  const chain = [...forwarded, remote];
  const candidateIndex = chain.length - trustedProxyHops - 1;
  return candidateIndex >= 0 ? chain[candidateIndex] : remote;
}

function readTrustedProxyHops(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error('BCC_TRUSTED_PROXY_HOPS must be an integer from 0 to 10');
  }
  return value;
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

function normalizeIp(value: string | undefined): string {
  if (!value) return '0.0.0.0';
  let normalized = value.trim();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
  if (normalized.startsWith('::ffff:')) {
    const ipv4 = normalized.slice('::ffff:'.length);
    if (isIP(ipv4) === 4) return ipv4;
  }
  return isIP(normalized) !== 0 ? normalized : '0.0.0.0';
}
