import type { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { assertRuntimeRoleNonPrivileged } from './db-role-check.service';

interface FakeLogger {
  errors: string[];
  logs: string[];
  error: (m: string) => void;
  log: (m: string) => void;
}

function makeLogger(): FakeLogger {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    logs,
    error: (m: string) => errors.push(m),
    log: (m: string) => logs.push(m),
  };
}

function makeDataSource(
  rows: Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>,
): DataSource {
  return {
    query: (_sql: string) => Promise.resolve(rows),
  } as unknown as DataSource;
}

describe('assertRuntimeRoleNonPrivileged', () => {
  it('resolves when the role is NOSUPERUSER NOBYPASSRLS', async () => {
    const ds = makeDataSource([
      { rolname: 'shyraq_app', rolsuper: false, rolbypassrls: false },
    ]);
    const log = makeLogger();
    await expect(
      assertRuntimeRoleNonPrivileged(ds, log as unknown as Logger),
    ).resolves.toBeUndefined();
    expect(log.errors).toEqual([]);
    expect(log.logs.some((m) => m.includes('shyraq_app'))).toBe(true);
  });

  it('throws db_role_check_failed when rolsuper is true', async () => {
    const ds = makeDataSource([
      { rolname: 'shyraq', rolsuper: true, rolbypassrls: false },
    ]);
    const log = makeLogger();
    await expect(
      assertRuntimeRoleNonPrivileged(ds, log as unknown as Logger),
    ).rejects.toThrow('db_role_check_failed');
    expect(log.errors[0]).toContain('shyraq');
    expect(log.errors[0]).toContain('rolsuper=true');
    expect(log.errors[0]).toContain('Refusing to');
  });

  it('throws db_role_check_failed when rolbypassrls is true', async () => {
    const ds = makeDataSource([
      { rolname: 'bypass_role', rolsuper: false, rolbypassrls: true },
    ]);
    const log = makeLogger();
    await expect(
      assertRuntimeRoleNonPrivileged(ds, log as unknown as Logger),
    ).rejects.toThrow('db_role_check_failed');
    expect(log.errors[0]).toContain('rolbypassrls=true');
  });

  it('throws when pg_roles returns no row for current_user', async () => {
    const ds = makeDataSource([]);
    const log = makeLogger();
    await expect(
      assertRuntimeRoleNonPrivileged(ds, log as unknown as Logger),
    ).rejects.toThrow('db_role_check_failed');
    expect(log.errors[0]).toContain('returned no rows');
  });
});
