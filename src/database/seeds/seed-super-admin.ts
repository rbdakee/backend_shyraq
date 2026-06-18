import 'reflect-metadata';
import bcrypt from 'bcryptjs';
import { AppDataSource } from '../data-source';

/**
 * Idempotent bootstrap of the platform super-admin into `saas_users`.
 *
 * The `saas_users` table starts EMPTY after migrations — nothing else seeds
 * it (no migration INSERT, no bootstrap code). Without a row here the Admin
 * Web super-admin login (`AuthService.superAdminLogin`) has nobody to match,
 * so a fresh deploy cannot be administered until this runs.
 *
 * Reads (same env the templates document):
 *   SUPER_ADMIN_SEED_EMAIL     — login email (required). Stored lower-cased
 *                                to match `superAdminLogin`'s normalisation.
 *   SUPER_ADMIN_SEED_PASSWORD  — plaintext password (required). bcrypt-hashed
 *                                with BCRYPT_COST (default 12), same as the
 *                                runtime `BcryptPasswordHasher`.
 *   SUPER_ADMIN_SEED_NAME      — display name (optional, default 'Super Admin').
 *
 * Idempotent: re-running upserts by unique `email`, resetting the password to
 * the env value and re-activating the account. Safe to run on every deploy.
 *
 * Connects via the migration DataSource (`src/database/data-source.ts`) — the
 * schema-owner role — so it runs alongside `migration:run`. `saas_users` is
 * not tenant-scoped (no RLS), so no GUC juggling is needed.
 *
 * Run:  npm run seed:super-admin
 */
async function seedSuperAdmin(): Promise<void> {
  const email = (process.env.SUPER_ADMIN_SEED_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_SEED_PASSWORD ?? '';
  const fullName = (process.env.SUPER_ADMIN_SEED_NAME ?? 'Super Admin').trim();
  const cost = process.env.BCRYPT_COST
    ? parseInt(process.env.BCRYPT_COST, 10)
    : 12;

  if (!email || !password) {
    throw new Error(
      'seed:super-admin requires SUPER_ADMIN_SEED_EMAIL and SUPER_ADMIN_SEED_PASSWORD to be set.',
    );
  }

  const passwordHash = await bcrypt.hash(password, cost);

  const dataSource = await AppDataSource.initialize();
  try {
    const existing: Array<{ id: string }> = await dataSource.query(
      `SELECT id FROM saas_users WHERE email = $1`,
      [email],
    );
    const existed = existing.length > 0;

    const inserted: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO saas_users (email, full_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'super_admin', true)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             full_name = EXCLUDED.full_name,
             role = 'super_admin',
             is_active = true
       RETURNING id`,
      [email, fullName, passwordHash],
    );

    console.log(
      `[seed:super-admin] ${existed ? 'updated' : 'created'} super_admin ${email} (id=${inserted[0].id})`,
    );
  } finally {
    await dataSource.destroy();
  }
}

seedSuperAdmin()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Print the full error (stack + any AggregateError sub-errors, e.g. a
    // refused DB connection) so a failed seed is debuggable, not a blank line.
    console.error('[seed:super-admin] failed:', err);
    process.exit(1);
  });
