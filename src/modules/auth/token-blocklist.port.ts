export abstract class TokenBlocklistPort {
  abstract isBlocked(jti: string): Promise<boolean>;
  /** expUnix is seconds-since-epoch — TTL is computed as (expUnix - now). */
  abstract blocklist(jti: string, expUnix: number): Promise<void>;
}

/**
 * Pub/sub side-channel for blocklist propagation. Decouples the write
 * path (auth.service → blocklist.blocklist()) from the read side
 * (websocket gateway listening for "kill these sockets") so neither
 * has to know about the other.
 *
 * Channel: `token:blocklist:events`. Payload is the bare `jti` string.
 *
 * Implemented via Redis pub/sub so events fan out to every api process
 * that owns sockets. Each api process subscribes once at boot and only
 * acts on locally-connected sockets — the redis-adapter is for socket.io
 * fan-out, NOT for blocklist signalling.
 */
export abstract class TokenBlocklistEventsPort {
  /** Subscribe to revocation events. Returns an unsubscribe handle. */
  abstract subscribe(handler: (jti: string) => void): Promise<() => void>;
}
