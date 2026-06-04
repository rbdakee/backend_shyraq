import { FcmPushAdapter, FcmSender } from './fcm-push.adapter';
import { FirebaseConfig } from './firebase-push.config';
import { PushPayload, PushTarget } from '../../domain/push-notification.port';

const CONFIG: FirebaseConfig = {
  projectId: 'shyraq-test',
  clientEmail: 'sa@shyraq-test.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
};

function target(overrides: Partial<PushTarget> = {}): PushTarget {
  return {
    userId: 'user-1',
    tokens: [{ id: 'tok-1', platform: 'android', token: 'device-token-1' }],
    ...overrides,
  };
}

const PAYLOAD: PushPayload = {
  title: 'Ребёнок прибыл в сад',
  body: 'Регистрация прихода зафиксирована.',
  data: { childId: 'child-1', eventId: 'evt-1' },
};

describe('FcmPushAdapter', () => {
  it('sends one FCM message per token with notification + data', async () => {
    const sent: unknown[] = [];
    const sender: FcmSender = {
      send: (message) => {
        sent.push(message);
        return Promise.resolve('fcm-message-id');
      },
    };
    const adapter = new FcmPushAdapter(CONFIG, sender);

    await adapter.send(
      target({
        tokens: [
          { id: 'tok-1', platform: 'android', token: 'device-token-1' },
          { id: 'tok-2', platform: 'ios', token: 'device-token-2' },
        ],
      }),
      PAYLOAD,
    );

    expect(sent).toEqual([
      expect.objectContaining({
        token: 'device-token-1',
        notification: { title: PAYLOAD.title, body: PAYLOAD.body },
        data: { childId: 'child-1', eventId: 'evt-1' },
      }),
      expect.objectContaining({ token: 'device-token-2' }),
    ]);
  });

  it('omits the data field when the payload carries no data', async () => {
    const sent: Record<string, unknown>[] = [];
    const sender: FcmSender = {
      send: (message) => {
        sent.push(message as unknown as Record<string, unknown>);
        return Promise.resolve('id');
      },
    };
    const adapter = new FcmPushAdapter(CONFIG, sender);

    await adapter.send(target(), { title: 't', body: 'b' });

    expect(sent).toHaveLength(1);
    expect('data' in sent[0]).toBe(false);
  });

  it('rethrows the firebase-admin error verbatim so the code is preserved', async () => {
    const fcmError = Object.assign(
      new Error('Requested entity was not found.'),
      { code: 'messaging/registration-token-not-registered' },
    );
    const sender: FcmSender = {
      send: () => Promise.reject(fcmError),
    };
    const adapter = new FcmPushAdapter(CONFIG, sender);

    await expect(adapter.send(target(), PAYLOAD)).rejects.toBe(fcmError);
  });

  it('stops at the first failing token (per-token dispatch contract)', async () => {
    let calls = 0;
    const sender: FcmSender = {
      send: () => {
        calls += 1;
        return Promise.reject(new Error('boom'));
      },
    };
    const adapter = new FcmPushAdapter(CONFIG, sender);

    await expect(
      adapter.send(
        target({
          tokens: [
            { id: 'tok-1', platform: 'android', token: 't1' },
            { id: 'tok-2', platform: 'ios', token: 't2' },
          ],
        }),
        PAYLOAD,
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});
