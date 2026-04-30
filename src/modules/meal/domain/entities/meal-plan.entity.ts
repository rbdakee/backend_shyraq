/**
 * POJO domain aggregate for a single day's meal plan within a kindergarten.
 * Holds zero or more MealItem children.
 * No TypeORM or NestJS imports allowed in this layer.
 */
import { MealItemNotFoundError } from '../errors/meal-item-not-found.error';
import {
  CreateMealItemInput,
  MealItem,
  MealItemState,
  MealTypeValue,
  MultiLangText,
  UpdateMealItemPatch,
} from './meal-item.entity';

export type MealPlanSource = 'manual' | 'cron' | 'copied';

export interface MealPlanState {
  id: string;
  kindergartenId: string;
  date: string; // ISO date string 'YYYY-MM-DD'
  groupId: string | null;
  isPublished: boolean;
  notes: MultiLangText | null;
  source: MealPlanSource;
  copiedFrom: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: MealItemState[];
}

export interface CreateMealPlanInput {
  id: string;
  kindergartenId: string;
  date: string;
  groupId?: string | null;
  isPublished?: boolean;
  notes?: MultiLangText | null;
  source?: MealPlanSource;
  copiedFrom?: string | null;
  createdBy?: string | null;
  now: Date;
  items?: CreateMealItemInput[];
}

export interface UpdateMealPlanPatch {
  isPublished?: boolean;
  notes?: MultiLangText | null;
}

export class MealPlan {
  readonly id: string;
  readonly kindergartenId: string;
  readonly date: string;
  readonly groupId: string | null;
  isPublished: boolean;
  notes: MultiLangText | null;
  source: MealPlanSource;
  copiedFrom: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;

  private _items: MealItem[];

  private constructor(state: MealPlanState) {
    this.id = state.id;
    this.kindergartenId = state.kindergartenId;
    this.date = state.date;
    this.groupId = state.groupId;
    this.isPublished = state.isPublished;
    this.notes = state.notes;
    this.source = state.source;
    this.copiedFrom = state.copiedFrom;
    this.createdBy = state.createdBy;
    this.createdAt = state.createdAt;
    this.updatedAt = state.updatedAt;
    this._items = state.items.map((i) => MealItem.hydrate(i));
  }

  get items(): MealItem[] {
    return [...this._items];
  }

  // ── factory ─────────────────────────────────────────────────────────────

  static create(input: CreateMealPlanInput): MealPlan {
    const now = input.now;
    const plan = new MealPlan({
      id: input.id,
      kindergartenId: input.kindergartenId,
      date: input.date,
      groupId: input.groupId ?? null,
      isPublished: input.isPublished ?? true,
      notes: input.notes ?? null,
      source: input.source ?? 'manual',
      copiedFrom: input.copiedFrom ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      items: [],
    });
    for (const item of input.items ?? []) {
      plan._items.push(MealItem.create(item));
    }
    return plan;
  }

  static hydrate(state: MealPlanState): MealPlan {
    return new MealPlan(state);
  }

  // ── mutations ────────────────────────────────────────────────────────────

  applyPatch(patch: UpdateMealPlanPatch, now: Date): void {
    if (patch.isPublished !== undefined) this.isPublished = patch.isPublished;
    if (patch.notes !== undefined) this.notes = patch.notes;
    this.updatedAt = now;
  }

  publish(now: Date): void {
    this.isPublished = true;
    this.updatedAt = now;
  }

  unpublish(now: Date): void {
    this.isPublished = false;
    this.updatedAt = now;
  }

  addItem(
    input: Omit<CreateMealItemInput, 'mealPlanId'> & {
      mealType: MealTypeValue;
    },
    now: Date,
  ): MealItem {
    const item = MealItem.create({ ...input, mealPlanId: this.id });
    this._items.push(item);
    this.updatedAt = now;
    return item;
  }

  updateItem(itemId: string, patch: UpdateMealItemPatch, now: Date): MealItem {
    const item = this._items.find((i) => i.id === itemId);
    if (!item) throw new MealItemNotFoundError(itemId);
    item.applyPatch(patch);
    this.updatedAt = now;
    return item;
  }

  removeItem(itemId: string, now: Date): void {
    const idx = this._items.findIndex((i) => i.id === itemId);
    if (idx === -1) throw new MealItemNotFoundError(itemId);
    this._items.splice(idx, 1);
    this.updatedAt = now;
  }

  // ── serialization ────────────────────────────────────────────────────────

  toState(): MealPlanState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      date: this.date,
      groupId: this.groupId,
      isPublished: this.isPublished,
      notes: this.notes,
      source: this.source,
      copiedFrom: this.copiedFrom,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      items: this._items.map((i) => i.toState()),
    };
  }
}
