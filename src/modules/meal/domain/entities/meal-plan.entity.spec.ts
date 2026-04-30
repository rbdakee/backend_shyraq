/**
 * Domain-unit tests for MealPlan aggregate.
 * Pure in-memory, no DB, no NestJS.
 */
import { MealItemNotFoundError } from '../errors/meal-item-not-found.error';
import { MealPlan } from './meal-plan.entity';

const NOW = new Date('2026-05-01T08:00:00.000Z');
const LATER = new Date('2026-05-01T09:00:00.000Z');

function makePlan(
  overrides?: Partial<Parameters<typeof MealPlan.create>[0]>,
): MealPlan {
  return MealPlan.create({
    id: 'plan-1',
    kindergartenId: 'kg-1',
    date: '2026-05-01',
    groupId: null,
    isPublished: true,
    now: NOW,
    ...overrides,
  });
}

describe('MealPlan', () => {
  describe('create', () => {
    it('returns a plan with default isPublished=true and empty items', () => {
      const plan = makePlan();
      expect(plan.isPublished).toBe(true);
      expect(plan.items).toHaveLength(0);
      expect(plan.source).toBe('manual');
    });

    it('accepts inline items via create input', () => {
      const plan = makePlan({
        items: [
          {
            id: 'item-1',
            mealPlanId: 'plan-1',
            mealType: 'lunch',
            dishName: { ru: 'Борщ', kk: 'Борщ' },
          },
        ],
      });
      expect(plan.items).toHaveLength(1);
      expect(plan.items[0].dishName.ru).toBe('Борщ');
    });
  });

  describe('publish / unpublish', () => {
    it('publishes an unpublished plan and updates updatedAt', () => {
      const plan = makePlan({ isPublished: false });
      plan.publish(LATER);
      expect(plan.isPublished).toBe(true);
      expect(plan.updatedAt).toEqual(LATER);
    });

    it('unpublishes a published plan and updates updatedAt', () => {
      const plan = makePlan({ isPublished: true });
      plan.unpublish(LATER);
      expect(plan.isPublished).toBe(false);
      expect(plan.updatedAt).toEqual(LATER);
    });
  });

  describe('addItem', () => {
    it('returns the new item and appends it to items list', () => {
      const plan = makePlan();
      const item = plan.addItem(
        { id: 'i-1', mealType: 'breakfast', dishName: { ru: 'Каша' } },
        LATER,
      );
      expect(item.mealType).toBe('breakfast');
      expect(plan.items).toHaveLength(1);
    });

    it('allows multiple items with the same meal_type', () => {
      const plan = makePlan();
      plan.addItem(
        { id: 'i-1', mealType: 'breakfast', dishName: { ru: 'Каша' } },
        LATER,
      );
      plan.addItem(
        { id: 'i-2', mealType: 'breakfast', dishName: { ru: 'Омлет' } },
        LATER,
      );
      expect(plan.items.filter((i) => i.mealType === 'breakfast')).toHaveLength(
        2,
      );
    });
  });

  describe('updateItem', () => {
    it('updates fields on an existing item', () => {
      const plan = makePlan();
      plan.addItem(
        { id: 'i-1', mealType: 'lunch', dishName: { ru: 'Суп' } },
        NOW,
      );
      plan.updateItem('i-1', { dishName: { ru: 'Борщ' } }, LATER);
      expect(plan.items[0].dishName.ru).toBe('Борщ');
      expect(plan.updatedAt).toEqual(LATER);
    });

    it('throws MealItemNotFoundError for unknown itemId', () => {
      const plan = makePlan();
      expect(() => plan.updateItem('missing', {}, LATER)).toThrow(
        MealItemNotFoundError,
      );
    });
  });

  describe('removeItem', () => {
    it('removes item from plan', () => {
      const plan = makePlan();
      plan.addItem(
        { id: 'i-1', mealType: 'dinner', dishName: { ru: 'Чай' } },
        NOW,
      );
      plan.removeItem('i-1', LATER);
      expect(plan.items).toHaveLength(0);
    });

    it('throws MealItemNotFoundError for unknown itemId', () => {
      const plan = makePlan();
      expect(() => plan.removeItem('nope', LATER)).toThrow(
        MealItemNotFoundError,
      );
    });
  });

  describe('toState / hydrate round-trip', () => {
    it('returns an identical plan after hydrate(toState())', () => {
      const plan = makePlan();
      plan.addItem(
        { id: 'i-1', mealType: 'snack_am', dishName: { ru: 'Фрукты' } },
        NOW,
      );
      const hydrated = MealPlan.hydrate(plan.toState());
      expect(hydrated.id).toBe(plan.id);
      expect(hydrated.items).toHaveLength(1);
      expect(hydrated.items[0].mealType).toBe('snack_am');
    });
  });
});
