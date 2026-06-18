/**
 * The runtime application DB role — read from `DATABASE_USERNAME`, NOT
 * hardcoded — so migrations create and grant to whatever role the deployment
 * actually connects with (e.g. `balam_app`).
 *
 * The value is interpolated directly into GRANT/REVOKE/CREATE ROLE SQL, so it
 * is validated as a plain PostgreSQL identifier; anything else throws rather
 * than risk SQL injection.
 *
 * Lives in `src/database/` (NOT under `migrations/`) so the TypeORM migrations
 * glob does not try to load it as a migration.
 */
export function appRoleName(): string {
  const name = process.env.DATABASE_USERNAME ?? '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `DATABASE_USERNAME='${name}' is not a valid PostgreSQL identifier ` +
        '(used as the runtime application role name in migrations).',
    );
  }
  return name;
}

/** Quoted-identifier form, ready to interpolate into SQL: `"balam_app"`. */
export function appRoleIdent(): string {
  return `"${appRoleName()}"`;
}
