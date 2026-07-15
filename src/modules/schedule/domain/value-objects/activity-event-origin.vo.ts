/**
 * Sealed enum-VO mirroring the DB column `activity_events.origin` — the
 * durable provenance marker for an activity event.
 *
 * Why it exists: `activity_events.template_slot_id` is declared ON DELETE SET
 * NULL, so editing a template (which DELETEs slots no longer in the desired
 * set) silently NULLs the FK on already-materialized events. Those orphans
 * then become indistinguishable from genuine ad-hoc events, which also carry
 * `template_slot_id = NULL`. `origin` is written once at creation and never
 * touched again, so it survives the slot delete and keeps the two cases apart.
 *
 *   'template' — projected from a schedule_template_slot by copyWeekToNext.
 *                `template_slot_id` may still be NULL if the slot was later
 *                deleted; the event is a template orphan, not an ad-hoc event.
 *   'adhoc'    — created directly by staff/admin; never had a slot.
 *
 * Immutable after creation: an event does not change provenance, so the domain
 * entity exposes a getter with no setter.
 */
export const ACTIVITY_EVENT_ORIGIN_VALUES = ['template', 'adhoc'] as const;

export type ActivityEventOriginValue =
  (typeof ACTIVITY_EVENT_ORIGIN_VALUES)[number];

export function isActivityEventOrigin(
  value: string,
): value is ActivityEventOriginValue {
  return (ACTIVITY_EVENT_ORIGIN_VALUES as readonly string[]).includes(value);
}
