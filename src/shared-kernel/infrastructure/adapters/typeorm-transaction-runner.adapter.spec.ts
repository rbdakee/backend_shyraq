import type { DataSource, EntityManager } from 'typeorm';
import { TypeOrmTransactionRunnerAdapter } from './typeorm-transaction-runner.adapter';

describe('TypeOrmTransactionRunnerAdapter', () => {
  it('delegates run(cb) to dataSource.transaction(cb) and forwards the return value', async () => {
    const fakeManager = { query: jest.fn() } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        <T>(cb: (m: EntityManager) => Promise<T>): Promise<T> =>
          cb(fakeManager),
      ),
    } as unknown as DataSource;

    const adapter = new TypeOrmTransactionRunnerAdapter(dataSource);
    const result = await adapter.run((m) => {
      expect(m).toBe(fakeManager);
      return Promise.resolve('ok' as const);
    });

    expect(result).toBe('ok');
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('propagates errors thrown inside the callback so callers can rely on rollback semantics', async () => {
    const fakeManager = {} as EntityManager;
    const dataSource = {
      transaction: <T>(cb: (m: EntityManager) => Promise<T>): Promise<T> =>
        cb(fakeManager),
    } as unknown as DataSource;

    const adapter = new TypeOrmTransactionRunnerAdapter(dataSource);
    await expect(
      adapter.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });
});
