import type { EntityManager } from 'typeorm';

/**
 * Re-export of TypeORM's EntityManager type so service-layer code can
 * annotate transaction-callback parameters without depending on the
 * 'typeorm' module directly. The runtime adapter
 * (TypeOrmTransactionRunnerAdapter) remains the only place under
 * src/shared-kernel/ that imports TypeORM concretely; service files import
 * the type alias from this port so the acceptance grep on
 * "import ... from 'typeorm'" in src/modules/...*.service.ts stays at zero.
 */
export type { EntityManager };

/**
 * TransactionRunnerPort — abstracts an atomic unit of work so services can
 * open transactions without importing DataSource from 'typeorm'. The
 * callback receives a TypeORM EntityManager bound to the open transaction;
 * services pass it through to repository methods that accept an optional
 * "manager?" and/or publish it into tenantStorage so RLS-scoped repos see
 * the same TX.
 *
 * Layered rules:
 *   - The port lives in src/shared-kernel/application/ports/ next to
 *     ClockPort. DI token = the abstract class itself (no Symbol/string).
 *   - The relational adapter lives in
 *     src/shared-kernel/infrastructure/adapters/typeorm-transaction-runner.adapter.ts
 *     and is the ONLY place outside src/database/ that imports DataSource.
 *   - SharedKernelModule (@Global) binds the adapter so every business
 *     module sees the port without re-importing.
 *
 * The callback returns the value produced by the service-level work; the
 * adapter propagates the resolved value and re-throws any error so callers
 * can rely on TypeORM rollback semantics. The transaction inherits the
 * default ambient isolation level (READ COMMITTED) — pass a typed isolation
 * option from inside the callback (manager.query for SET TRANSACTION ...)
 * when stricter semantics are required.
 */
export abstract class TransactionRunnerPort {
  abstract run<T>(cb: (manager: EntityManager) => Promise<T>): Promise<T>;
}
