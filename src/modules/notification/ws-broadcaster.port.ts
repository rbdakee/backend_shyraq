/**
 * WsBroadcaster — abstract port for socket.io fan-out from the notification
 * dispatcher to live-connected client sockets.
 *
 * Three rooms supported (matches `endpoints.md §0.6`):
 *   - `user:{userId}`  — single recipient (per-user inbox push)
 *   - `child:{childId}` — every guardian + assigned mentor of the child
 *   - `group:{groupId}` — every mentor of the group
 *
 * Calls are fire-and-forget — the dispatcher does not await them. T5 will
 * provide the real socket.io implementation backed by `@socket.io/redis-adapter`
 * so multi-process api+worker deployments can broadcast across processes.
 *
 * For T4, a `NoopWsBroadcaster` satisfies the port: it logs each call so the
 * dispatcher path is exercised, but emits no actual socket events. That keeps
 * T4 focused on the recipient/preference/push logic without dragging in WS
 * scaffolding before T5.
 */
export abstract class WsBroadcaster {
  abstract broadcastToUser(
    userId: string,
    eventName: string,
    payload: unknown,
  ): void;

  abstract broadcastToChild(
    childId: string,
    eventName: string,
    payload: unknown,
  ): void;

  abstract broadcastToGroup(
    groupId: string,
    eventName: string,
    payload: unknown,
  ): void;
}
