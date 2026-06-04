import { buildFirebaseConfig } from './firebase-push.config';

describe('buildFirebaseConfig', () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  function setEnv(env: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  it('builds the config and restores newlines in the private key', () => {
    setEnv({
      FIREBASE_PROJECT_ID: 'shyraq-prod',
      FIREBASE_CLIENT_EMAIL: 'sa@shyraq-prod.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY:
        '-----BEGIN PRIVATE KEY-----\\nLINE\\n-----END PRIVATE KEY-----\\n',
    });

    const config = buildFirebaseConfig();

    expect(config.projectId).toBe('shyraq-prod');
    expect(config.clientEmail).toBe('sa@shyraq-prod.iam.gserviceaccount.com');
    expect(config.privateKey).toBe(
      '-----BEGIN PRIVATE KEY-----\nLINE\n-----END PRIVATE KEY-----\n',
    );
  });

  it('strips a single layer of wrapping quotes around the private key', () => {
    setEnv({
      FIREBASE_PROJECT_ID: 'p',
      FIREBASE_CLIENT_EMAIL: 'e',
      FIREBASE_PRIVATE_KEY:
        '"-----BEGIN PRIVATE KEY-----\\nK\\n-----END PRIVATE KEY-----\\n"',
    });

    expect(buildFirebaseConfig().privateKey).toBe(
      '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n',
    );
  });

  it('throws when any FIREBASE_* cred is missing', () => {
    setEnv({
      FIREBASE_PROJECT_ID: 'p',
      FIREBASE_CLIENT_EMAIL: undefined,
      FIREBASE_PRIVATE_KEY: 'k',
    });

    expect(() => buildFirebaseConfig()).toThrow(/PUSH_PROVIDER=fcm requires/);
  });
});
