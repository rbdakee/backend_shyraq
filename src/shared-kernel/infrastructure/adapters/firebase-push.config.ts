/**
 * Firebase service-account credentials for the FCM push adapter.
 *
 * Read directly from `process.env` (mirrors how `pushPortProvider` selects the
 * adapter by `PUSH_PROVIDER` — the push wiring predates the module's
 * `registerAs` config and stays env-direct for parity). The builder is only
 * invoked when `PUSH_PROVIDER=fcm`, so the three creds are mandatory there and
 * a missing one fails app/worker bootstrap loudly rather than silently dropping
 * pushes at runtime.
 */
export interface FirebaseConfig {
  projectId: string;
  clientEmail: string;
  /** PEM private key with real newlines (env stores them as literal `\n`). */
  privateKey: string;
}

/**
 * Build the Firebase config from env. Throws when `PUSH_PROVIDER=fcm` but any
 * of `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`
 * is absent. The private key is `.env`-friendly: stored on a single line with
 * `\n` escapes, which we convert back to real newlines so `credential.cert`
 * accepts the PEM.
 */
export function buildFirebaseConfig(): FirebaseConfig {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    throw new Error(
      'PUSH_PROVIDER=fcm requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY to be set',
    );
  }

  return {
    projectId,
    clientEmail,
    privateKey: normalizePrivateKey(rawPrivateKey),
  };
}

/**
 * Service-account private keys are multi-line PEM blocks. In `.env` files the
 * newlines are escaped as the characters `\` + `n`; some secret stores also
 * wrap the value in surrounding quotes. Restore real newlines and strip a
 * single layer of wrapping quotes so the value matches the original PEM.
 *
 * The escape is matched as `\\+n` (one-OR-MORE backslashes before `n`) on
 * purpose: copy-pasting the JSON `private_key` through a shell, a docker
 * `env_file`, or a re-quoting editor frequently double-escapes it to `\\n`.
 * A naive single-backslash replace would leave a stray `\` on every line and
 * OpenSSL rejects the result with `DECODER routines::unsupported`. Collapsing
 * any run of backslashes before `n` to one newline is safe — a real PEM body
 * is base64 and never contains a literal backslash.
 */
function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\+r/g, '').replace(/\\+n/g, '\n');
}
