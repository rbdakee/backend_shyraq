import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

export function getCurrentKindergartenId(): string | null {
  return tenantStorage.getStore()?.kgId ?? null;
}

export async function runInTenant<T>(
  ctx: TenantContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  return tenantStorage.run(ctx, async () => await fn());
}
