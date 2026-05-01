import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

/**
 * Worker process bootstrap. Distinct from `src/main.ts` (the api process):
 *   - No HTTP listener — `createApplicationContext` builds a Nest container
 *     without binding a port. The worker only consumes BullMQ jobs and
 *     publishes through Redis, so HTTP would be dead weight.
 *   - No global guards / interceptors / filters — those are HTTP concerns.
 *   - Loads `WorkerModule` (TypeORM + BullMQ + NotificationModule + the
 *     two processors + scheduler) instead of `AppModule`.
 *
 * Lifecycle:
 *   - `--check` flag short-circuits after init for smoke testing
 *     (`npm run start:worker -- --check` exits 0 on success).
 *   - `SIGTERM` / `SIGINT` triggers graceful shutdown via `app.close()`,
 *     which fires `OnModuleDestroy` on every provider — including
 *     `WorkerSocketIoServerProvider` (closes its Redis pub/sub clients
 *     and the publisher-only socket.io Server) and BullMQ workers
 *     registered by `@Processor`.
 *
 * Process exit codes:
 *   - 0 — clean shutdown (SIGTERM/SIGINT handled, or --check passed).
 *   - 1 — bootstrap failure or unhandled error during shutdown.
 */
const logger = new Logger('Worker');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    // BullMQ + redis-adapter are noisy at debug level; default the worker
    // to the api's "operational" log levels and let the operator override
    // via `LOG_LEVEL` if needed.
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();

  if (process.argv.includes('--check')) {
    logger.log('worker: check ok');
    await app.close();
    process.exit(0);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`worker: ${signal} received, shutting down`);
    try {
      await app.close();
    } catch (err) {
      logger.error(
        `worker: shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.log('worker: ready');
}

bootstrap().catch((err) => {
  // Top-level boot failure — print and exit non-zero so the process
  // supervisor (systemd / docker) restarts the worker.

  console.error('worker bootstrap failed', err);
  process.exit(1);
});
