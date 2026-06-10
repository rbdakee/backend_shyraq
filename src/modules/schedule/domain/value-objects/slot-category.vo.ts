/**
 * Sealed enum-VO mirroring the DB enum `slot_category`. Drives the colour
 * bucket the admin week-grid (and staff/parent day views) paint each slot /
 * activity_event with. Human-readable labels (Урок / Активность / Еда / Сон)
 * live on the frontend — the backend only persists the canonical value.
 *
 * Shared by `schedule_template_slots.category` and `activity_events.category`
 * (the latter is copied from the slot during the week-copy projection; ad-hoc
 * events default to `activity`).
 */
export const SLOT_CATEGORY_VALUES = [
  'lesson',
  'activity',
  'meal',
  'sleep',
] as const;

export type SlotCategoryValue = (typeof SLOT_CATEGORY_VALUES)[number];

/** Server-side fallback when a client omits `category`. */
export const DEFAULT_SLOT_CATEGORY: SlotCategoryValue = 'activity';

export function isSlotCategory(value: string): value is SlotCategoryValue {
  return (SLOT_CATEGORY_VALUES as readonly string[]).includes(value);
}
