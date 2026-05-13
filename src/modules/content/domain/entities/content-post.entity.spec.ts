import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { ContentPostStatusInvalidError } from '../errors/content-post-status-invalid.error';
import { ContentTargetInvalidError } from '../errors/content-target-invalid.error';
import {
  ContentPost,
  ContentPostState,
  ContentStatus,
} from './content-post.entity';

const NOW = new Date('2026-05-07T10:00:00Z');
const FUTURE = new Date('2026-05-08T10:00:00Z');
const PAST = new Date('2026-05-06T10:00:00Z');

function makeState(
  overrides: Partial<ContentPostState> = {},
): ContentPostState {
  return {
    id: 'cp-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    contentType: 'news',
    targetType: 'all',
    targetGroupId: null,
    targetChildId: null,
    title: null,
    body: null,
    titleI18n: { ru: 'Привет', kk: 'Сәлем' },
    bodyI18n: { ru: 'Текст', kk: 'Мәтін' },
    mediaUrls: null,
    metadata: null,
    scheduledFor: null,
    publishedAt: null,
    expiresAt: null,
    status: 'draft',
    createdBy: 'user-uuid-0001',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fromState(overrides: Partial<ContentPostState> = {}): ContentPost {
  return ContentPost.fromState(makeState(overrides));
}

describe('ContentPost domain entity', () => {
  // ── factory create() ───────────────────────────────────────────────────

  describe('create()', () => {
    it('returns draft for news/all without scheduledFor', () => {
      const p = ContentPost.create({
        id: 'cp-1',
        kindergartenId: 'kg-1',
        contentType: 'news',
        targetType: 'all',
        titleI18n: { ru: 'T', kk: 'T' },
        now: NOW,
      });
      expect(p.status).toBe('draft');
      expect(p.contentType).toBe('news');
      expect(p.targetType).toBe('all');
      expect(p.targetGroupId).toBeNull();
      expect(p.targetChildId).toBeNull();
      expect(p.publishedAt).toBeNull();
      expect(p.scheduledFor).toBeNull();
      expect(p.createdAt).toEqual(NOW);
      expect(p.updatedAt).toEqual(NOW);
    });

    it('returns scheduled when scheduledFor is in the future', () => {
      const p = ContentPost.create({
        id: 'cp-1',
        kindergartenId: 'kg-1',
        contentType: 'menu',
        targetType: 'all',
        scheduledFor: FUTURE,
        now: NOW,
      });
      expect(p.status).toBe('scheduled');
      expect(p.scheduledFor).toEqual(FUTURE);
    });

    it('throws ContentPostStatusInvalidError when scheduledFor is in the past', () => {
      expect(() =>
        ContentPost.create({
          id: 'cp-1',
          kindergartenId: 'kg-1',
          contentType: 'news',
          targetType: 'all',
          scheduledFor: PAST,
          now: NOW,
        }),
      ).toThrow(ContentPostStatusInvalidError);
    });

    it('accepts targetType=group with non-null targetGroupId and null targetChildId', () => {
      const p = ContentPost.create({
        id: 'cp-1',
        kindergartenId: 'kg-1',
        contentType: 'news',
        targetType: 'group',
        targetGroupId: 'g-1',
        now: NOW,
      });
      expect(p.targetType).toBe('group');
      expect(p.targetGroupId).toBe('g-1');
      expect(p.targetChildId).toBeNull();
    });

    it('accepts targetType=child with non-null targetChildId and null targetGroupId', () => {
      const p = ContentPost.create({
        id: 'cp-1',
        kindergartenId: 'kg-1',
        contentType: 'news',
        targetType: 'child',
        targetChildId: 'c-1',
        now: NOW,
      });
      expect(p.targetType).toBe('child');
      expect(p.targetChildId).toBe('c-1');
      expect(p.targetGroupId).toBeNull();
    });

    it('throws ContentTargetInvalidError when targetType=all but targetGroupId is set', () => {
      expect(() =>
        ContentPost.create({
          id: 'cp-1',
          kindergartenId: 'kg-1',
          contentType: 'news',
          targetType: 'all',
          targetGroupId: 'g-1',
          now: NOW,
        }),
      ).toThrow(ContentTargetInvalidError);
    });

    it('throws ContentTargetInvalidError when targetType=all but targetChildId is set', () => {
      expect(() =>
        ContentPost.create({
          id: 'cp-1',
          kindergartenId: 'kg-1',
          contentType: 'news',
          targetType: 'all',
          targetChildId: 'c-1',
          now: NOW,
        }),
      ).toThrow(ContentTargetInvalidError);
    });

    it('throws ContentTargetInvalidError when targetType=group with null targetGroupId', () => {
      expect(() =>
        ContentPost.create({
          id: 'cp-1',
          kindergartenId: 'kg-1',
          contentType: 'news',
          targetType: 'group',
          now: NOW,
        }),
      ).toThrow(ContentTargetInvalidError);
    });

    it('throws ContentTargetInvalidError when targetType=group with both ids set', () => {
      expect(() =>
        ContentPost.create({
          id: 'cp-1',
          kindergartenId: 'kg-1',
          contentType: 'news',
          targetType: 'group',
          targetGroupId: 'g-1',
          targetChildId: 'c-1',
          now: NOW,
        }),
      ).toThrow(ContentTargetInvalidError);
    });

    it('throws ContentTargetInvalidError when targetType=child with null targetChildId', () => {
      expect(() =>
        ContentPost.create({
          id: 'cp-1',
          kindergartenId: 'kg-1',
          contentType: 'news',
          targetType: 'child',
          now: NOW,
        }),
      ).toThrow(ContentTargetInvalidError);
    });

    it('throws ContentTargetInvalidError when targetType=child with both ids set', () => {
      expect(() =>
        ContentPost.create({
          id: 'cp-1',
          kindergartenId: 'kg-1',
          contentType: 'news',
          targetType: 'child',
          targetGroupId: 'g-1',
          targetChildId: 'c-1',
          now: NOW,
        }),
      ).toThrow(ContentTargetInvalidError);
    });

    it('accepts qundylyq content type with metadata', () => {
      const p = ContentPost.create({
        id: 'cp-1',
        kindergartenId: 'kg-1',
        contentType: 'qundylyq',
        targetType: 'all',
        metadata: { month: '2026-05', theme: 'Honesty' },
        now: NOW,
      });
      expect(p.contentType).toBe('qundylyq');
      expect(p.metadata).toEqual({ month: '2026-05', theme: 'Honesty' });
    });

    it('accepts schedule_pub content type', () => {
      const p = ContentPost.create({
        id: 'cp-1',
        kindergartenId: 'kg-1',
        contentType: 'schedule_pub',
        targetType: 'group',
        targetGroupId: 'g-1',
        now: NOW,
      });
      expect(p.contentType).toBe('schedule_pub');
    });
  });

  // ── factory createBirthday() ───────────────────────────────────────────

  describe('createBirthday()', () => {
    it('returns published birthday post with i18n title/body and metadata', () => {
      const p = ContentPost.createBirthday({
        id: 'cp-bday-1',
        kindergartenId: 'kg-1',
        targetChildId: 'child-1',
        childFullName: 'Айгерим',
        childAge: 5,
        now: NOW,
      });
      expect(p.contentType).toBe('birthday');
      expect(p.targetType).toBe('child');
      expect(p.targetChildId).toBe('child-1');
      expect(p.targetGroupId).toBeNull();
      expect(p.status).toBe('published');
      expect(p.publishedAt).toEqual(NOW);
      expect(p.createdBy).toBeNull();
      expect(p.titleI18n?.ru).toContain('Айгерим');
      expect(p.titleI18n?.kk).toContain('Айгерим');
      expect(p.bodyI18n?.ru).toContain('5');
      expect(p.bodyI18n?.kk).toContain('5');
      expect(p.metadata).toEqual({ child_id: 'child-1', age: 5 });
    });
  });

  // ── schedule() transition ──────────────────────────────────────────────

  describe('schedule()', () => {
    it('transitions draft → scheduled and sets scheduledFor', () => {
      const p = fromState({ status: 'draft' });
      p.schedule(FUTURE, NOW);
      expect(p.status).toBe('scheduled');
      expect(p.scheduledFor).toEqual(FUTURE);
      expect(p.updatedAt).toEqual(NOW);
    });

    it('throws when scheduledFor equals now (must be strictly future)', () => {
      const p = fromState({ status: 'draft' });
      expect(() => p.schedule(NOW, NOW)).toThrow(ContentPostStatusInvalidError);
    });

    it('throws when scheduledFor is in the past', () => {
      const p = fromState({ status: 'draft' });
      expect(() => p.schedule(PAST, NOW)).toThrow(
        ContentPostStatusInvalidError,
      );
    });

    it('throws from scheduled (already scheduled — use update for date change)', () => {
      const p = fromState({ status: 'scheduled', scheduledFor: FUTURE });
      expect(() => p.schedule(FUTURE, NOW)).toThrow(
        ContentPostStatusInvalidError,
      );
    });

    it('throws from published (terminal)', () => {
      const p = fromState({ status: 'published', publishedAt: PAST });
      expect(() => p.schedule(FUTURE, NOW)).toThrow(
        ContentPostStatusInvalidError,
      );
    });
  });

  // ── publish() transition ───────────────────────────────────────────────

  describe('publish()', () => {
    it('transitions draft → published and sets publishedAt', () => {
      const p = fromState({ status: 'draft' });
      p.publish(NOW);
      expect(p.status).toBe('published');
      expect(p.publishedAt).toEqual(NOW);
      expect(p.updatedAt).toEqual(NOW);
    });

    it('transitions scheduled → published and sets publishedAt', () => {
      const p = fromState({ status: 'scheduled', scheduledFor: FUTURE });
      p.publish(NOW);
      expect(p.status).toBe('published');
      expect(p.publishedAt).toEqual(NOW);
    });

    it('throws from published (terminal)', () => {
      const p = fromState({ status: 'published', publishedAt: PAST });
      expect(() => p.publish(NOW)).toThrow(ContentPostStatusInvalidError);
    });
  });

  // ── update() patches ───────────────────────────────────────────────────

  describe('update()', () => {
    it('applies title/body/titleI18n/bodyI18n/mediaUrls/metadata/expiresAt patches from draft', () => {
      const p = fromState({ status: 'draft' });
      p.update(
        {
          title: 'New title',
          body: 'New body',
          titleI18n: { ru: 'Заголовок', kk: 'Тақырып' },
          bodyI18n: { ru: 'Тело', kk: 'Дене' },
          mediaUrls: ['https://x/y.jpg'],
          metadata: { tag: 'urgent' },
          expiresAt: FUTURE,
        },
        NOW,
      );
      expect(p.title).toBe('New title');
      expect(p.body).toBe('New body');
      expect(p.titleI18n).toEqual({ ru: 'Заголовок', kk: 'Тақырып' });
      expect(p.bodyI18n).toEqual({ ru: 'Тело', kk: 'Дене' });
      expect(p.mediaUrls).toEqual(['https://x/y.jpg']);
      expect(p.metadata).toEqual({ tag: 'urgent' });
      expect(p.expiresAt).toEqual(FUTURE);
      expect(p.updatedAt).toEqual(NOW);
    });

    it('clears nullable fields when patched with null', () => {
      const p = fromState({
        status: 'draft',
        title: 'old',
        titleI18n: { ru: 'old' },
      });
      p.update({ title: null, titleI18n: null }, NOW);
      expect(p.title).toBeNull();
      expect(p.titleI18n).toBeNull();
    });

    it('leaves untouched fields alone when patch omits them', () => {
      const p = fromState({
        status: 'draft',
        title: 'keep-me',
        body: 'keep-too',
      });
      p.update({ mediaUrls: ['x'] }, NOW);
      expect(p.title).toBe('keep-me');
      expect(p.body).toBe('keep-too');
      expect(p.mediaUrls).toEqual(['x']);
    });

    it('updates from scheduled (allowed)', () => {
      const p = fromState({ status: 'scheduled', scheduledFor: FUTURE });
      p.update({ title: 'updated' }, NOW);
      expect(p.title).toBe('updated');
    });

    it('throws from published (terminal)', () => {
      const p = fromState({ status: 'published', publishedAt: PAST });
      expect(() => p.update({ title: 'late' }, NOW)).toThrow(
        ContentPostStatusInvalidError,
      );
    });

    it('throws content_type_immutable when payload tries to mutate contentType via dynamic injection', () => {
      const p = fromState({ status: 'draft' });
      const sneaky = { contentType: 'birthday' } as Record<string, unknown>;
      expect(() => p.update(sneaky as never, NOW)).toThrow(
        ContentPostStatusInvalidError,
      );
    });

    it('re-validates target invariant after target patch (group → all clears ids)', () => {
      const p = fromState({
        status: 'draft',
        targetType: 'group',
        targetGroupId: 'g-1',
      });
      p.update(
        { targetType: 'all', targetGroupId: null, targetChildId: null },
        NOW,
      );
      expect(p.targetType).toBe('all');
      expect(p.targetGroupId).toBeNull();
    });

    it('throws ContentTargetInvalidError when target patch leaves invalid shape (all + groupId)', () => {
      const p = fromState({ status: 'draft', targetType: 'all' });
      expect(() => p.update({ targetGroupId: 'g-1' }, NOW)).toThrow(
        ContentTargetInvalidError,
      );
    });

    it('throws ContentTargetInvalidError when changing to child without targetChildId', () => {
      const p = fromState({ status: 'draft', targetType: 'all' });
      expect(() => p.update({ targetType: 'child' }, NOW)).toThrow(
        ContentTargetInvalidError,
      );
    });

    it('updates scheduledFor when status=scheduled and new value is in future', () => {
      const p = fromState({ status: 'scheduled', scheduledFor: FUTURE });
      const farther = new Date(FUTURE.getTime() + 24 * 3600_000);
      p.update({ scheduledFor: farther }, NOW);
      expect(p.scheduledFor).toEqual(farther);
    });

    it('throws when updating scheduledFor to the past on a scheduled post', () => {
      const p = fromState({ status: 'scheduled', scheduledFor: FUTURE });
      expect(() => p.update({ scheduledFor: PAST }, NOW)).toThrow(
        ContentPostStatusInvalidError,
      );
    });

    it('throws when patching scheduledFor on a draft (use schedule() instead)', () => {
      const p = fromState({ status: 'draft' });
      expect(() => p.update({ scheduledFor: FUTURE }, NOW)).toThrow(
        ContentPostStatusInvalidError,
      );
    });

    it('throws when patching scheduledFor to null on a scheduled post (no un-schedule)', () => {
      const p = fromState({ status: 'scheduled', scheduledFor: FUTURE });
      expect(() => p.update({ scheduledFor: null }, NOW)).toThrow(
        ContentPostStatusInvalidError,
      );
    });
  });

  // ── canDelete() guard ──────────────────────────────────────────────────

  describe('canDelete()', () => {
    const cases: Array<[ContentStatus, boolean]> = [
      ['draft', true],
      ['scheduled', false],
      ['published', false],
    ];
    cases.forEach(([s, expected]) => {
      it(`returns ${expected} when status=${s}`, () => {
        const p = fromState({
          status: s,
          publishedAt: s === 'published' ? PAST : null,
          scheduledFor: s === 'scheduled' ? FUTURE : null,
        });
        expect(p.canDelete()).toBe(expected);
      });
    });
  });

  // ── canEdit() guard ────────────────────────────────────────────────────

  describe('canEdit()', () => {
    it('returns true for draft and scheduled, false for published', () => {
      expect(fromState({ status: 'draft' }).canEdit()).toBe(true);
      expect(
        fromState({ status: 'scheduled', scheduledFor: FUTURE }).canEdit(),
      ).toBe(true);
      expect(
        fromState({ status: 'published', publishedAt: PAST }).canEdit(),
      ).toBe(false);
    });
  });

  // ── fromState/toState round-trip ───────────────────────────────────────

  describe('fromState/toState', () => {
    it('round-trips state through fromState/toState', () => {
      const s = makeState({ status: 'scheduled', scheduledFor: FUTURE });
      const p = ContentPost.fromState(s);
      const out = p.toState();
      expect(out).toEqual(s);
    });

    it('toState returns a copy (mutations on the snapshot do not leak)', () => {
      const p = fromState();
      const a = p.toState();
      a.status = 'published';
      expect(p.status).toBe('draft');
    });
  });

  // ── invariants from fromState (defensive) ──────────────────────────────

  describe('fromState invariants', () => {
    it('throws InvariantViolationError on unknown contentType', () => {
      expect(() =>
        ContentPost.fromState(
          makeState({ contentType: 'galaxy_brain' as never }),
        ),
      ).toThrow(InvariantViolationError);
    });

    it('throws ContentTargetInvalidError on corrupted target shape (all + groupId)', () => {
      expect(() =>
        ContentPost.fromState(
          makeState({ targetType: 'all', targetGroupId: 'g-1' }),
        ),
      ).toThrow(ContentTargetInvalidError);
    });
  });
});
