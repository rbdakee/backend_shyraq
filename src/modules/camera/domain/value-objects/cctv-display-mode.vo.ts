/**
 * What a parent is shown for one slot of the day.
 *
 *   - `schedule` — the historical behaviour: follow the child's group, i.e.
 *                  the scheduled room now, else the group's hand-set location.
 *                  The slot's camera list is the FALLBACK for when that chain
 *                  points nowhere (no group, no location, no camera there).
 *   - `cameras`  — show exactly the slot's camera list to every parent,
 *                  ignoring where the group is. This is what a kindergarten
 *                  uses while the per-room cameras are not live yet: point
 *                  everyone at the entrance cameras and nothing else.
 *   - `off`      — show nothing at all; the app gets an empty list.
 */
export type CctvDisplayMode = 'schedule' | 'cameras' | 'off';

export const CCTV_DISPLAY_MODES: readonly CctvDisplayMode[] = [
  'schedule',
  'cameras',
  'off',
];

export function isCctvDisplayMode(value: unknown): value is CctvDisplayMode {
  return (
    typeof value === 'string' &&
    CCTV_DISPLAY_MODES.includes(value as CctvDisplayMode)
  );
}
