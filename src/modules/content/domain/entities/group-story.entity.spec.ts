import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { FileUploadError } from '../errors/file-upload.error';
import { GroupStoryExpiredError } from '../errors/group-story-expired.error';
import { MediaTypeInvalidError } from '../errors/media-type-invalid.error';
import { GroupStory, GroupStoryState } from './group-story.entity';

const NOW = new Date('2026-05-07T10:00:00Z');
const STORY_TTL_MS = 24 * 60 * 60 * 1000;
const EXPIRES = new Date(NOW.getTime() + STORY_TTL_MS);

function makeState(overrides: Partial<GroupStoryState> = {}): GroupStoryState {
  return {
    id: 'gs-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    groupId: 'group-uuid-0001',
    createdBy: 'user-uuid-author',
    mediaUrl: 'https://example.com/story.jpg',
    mediaType: 'image',
    caption: null,
    views: 0,
    expiresAt: EXPIRES,
    createdAt: NOW,
    ...overrides,
  };
}

function fromState(overrides: Partial<GroupStoryState> = {}): GroupStory {
  return GroupStory.fromState(makeState(overrides));
}

describe('GroupStory domain entity', () => {
  // ── factory create() ───────────────────────────────────────────────────

  describe('create()', () => {
    it('returns image story with expiresAt = now + 24h, views=0', () => {
      const s = GroupStory.create({
        id: 'gs-1',
        kindergartenId: 'kg-1',
        groupId: 'g-1',
        createdBy: 'user-1',
        mediaUrl: 'https://x/y.jpg',
        mediaType: 'image',
        now: NOW,
      });
      expect(s.mediaType).toBe('image');
      expect(s.views).toBe(0);
      expect(s.createdAt).toEqual(NOW);
      expect(s.expiresAt.getTime()).toBe(NOW.getTime() + STORY_TTL_MS);
      expect(s.caption).toBeNull();
    });

    it('returns video story with caption', () => {
      const s = GroupStory.create({
        id: 'gs-1',
        kindergartenId: 'kg-1',
        groupId: 'g-1',
        createdBy: 'user-1',
        mediaUrl: 'https://x/y.mp4',
        mediaType: 'video',
        caption: 'Утренняя зарядка',
        now: NOW,
      });
      expect(s.mediaType).toBe('video');
      expect(s.caption).toBe('Утренняя зарядка');
    });

    it('throws MediaTypeInvalidError on unknown mediaType (defensive cast)', () => {
      expect(() =>
        GroupStory.create({
          id: 'gs-1',
          kindergartenId: 'kg-1',
          groupId: 'g-1',
          createdBy: 'user-1',
          mediaUrl: 'https://x/y',
          mediaType: 'audio' as never,
          now: NOW,
        }),
      ).toThrow(MediaTypeInvalidError);
    });

    it('throws FileUploadError when mediaUrl is empty', () => {
      expect(() =>
        GroupStory.create({
          id: 'gs-1',
          kindergartenId: 'kg-1',
          groupId: 'g-1',
          createdBy: 'user-1',
          mediaUrl: '',
          mediaType: 'image',
          now: NOW,
        }),
      ).toThrow(FileUploadError);
    });

    it('throws FileUploadError when mediaUrl is whitespace-only', () => {
      expect(() =>
        GroupStory.create({
          id: 'gs-1',
          kindergartenId: 'kg-1',
          groupId: 'g-1',
          createdBy: 'user-1',
          mediaUrl: '   ',
          mediaType: 'image',
          now: NOW,
        }),
      ).toThrow(FileUploadError);
    });
  });

  // ── incrementViews() ───────────────────────────────────────────────────

  describe('incrementViews()', () => {
    it('increments views from 0 to 1', () => {
      const s = fromState({ views: 0 });
      s.incrementViews();
      expect(s.views).toBe(1);
    });

    it('increments views from 42 to 43', () => {
      const s = fromState({ views: 42 });
      s.incrementViews();
      expect(s.views).toBe(43);
    });
  });

  // ── isExpired() ────────────────────────────────────────────────────────

  describe('isExpired()', () => {
    it('returns false just before expiry', () => {
      const s = fromState({ expiresAt: EXPIRES });
      const justBefore = new Date(EXPIRES.getTime() - 1);
      expect(s.isExpired(justBefore)).toBe(false);
    });

    it('returns true at expiry boundary (now === expiresAt)', () => {
      const s = fromState({ expiresAt: EXPIRES });
      expect(s.isExpired(EXPIRES)).toBe(true);
    });

    it('returns true after expiry', () => {
      const s = fromState({ expiresAt: EXPIRES });
      const justAfter = new Date(EXPIRES.getTime() + 1);
      expect(s.isExpired(justAfter)).toBe(true);
    });
  });

  // ── assertNotExpired() ─────────────────────────────────────────────────

  describe('assertNotExpired()', () => {
    it('does not throw before expiry', () => {
      const s = fromState({ expiresAt: EXPIRES });
      expect(() => s.assertNotExpired(NOW)).not.toThrow();
    });

    it('throws GroupStoryExpiredError after expiry', () => {
      const s = fromState({ expiresAt: EXPIRES });
      const justAfter = new Date(EXPIRES.getTime() + 1);
      expect(() => s.assertNotExpired(justAfter)).toThrow(
        GroupStoryExpiredError,
      );
    });
  });

  // ── canBeDeletedBy() ───────────────────────────────────────────────────

  describe('canBeDeletedBy()', () => {
    it('returns true for the author (regardless of role)', () => {
      const s = fromState({ createdBy: 'user-author' });
      expect(s.canBeDeletedBy({ userId: 'user-author', role: 'mentor' })).toBe(
        true,
      );
    });

    it('returns true for any admin (even non-author)', () => {
      const s = fromState({ createdBy: 'user-author' });
      expect(s.canBeDeletedBy({ userId: 'user-other', role: 'admin' })).toBe(
        true,
      );
    });

    it('returns false for a different mentor', () => {
      const s = fromState({ createdBy: 'user-author' });
      expect(s.canBeDeletedBy({ userId: 'user-other', role: 'mentor' })).toBe(
        false,
      );
    });

    it('returns false for a parent', () => {
      const s = fromState({ createdBy: 'user-author' });
      expect(s.canBeDeletedBy({ userId: 'user-other', role: 'parent' })).toBe(
        false,
      );
    });

    it('returns false for a specialist (non-author)', () => {
      const s = fromState({ createdBy: 'user-author' });
      expect(
        s.canBeDeletedBy({ userId: 'user-other', role: 'specialist' }),
      ).toBe(false);
    });
  });

  // ── fromState/toState round-trip ───────────────────────────────────────

  describe('fromState/toState', () => {
    it('round-trips state', () => {
      const s = makeState({ views: 7, caption: 'cap' });
      const story = GroupStory.fromState(s);
      const out = story.toState();
      expect(out).toEqual(s);
    });

    it('toState returns a copy (mutations on the snapshot do not leak)', () => {
      const story = fromState();
      const a = story.toState();
      a.views = 999;
      expect(story.views).toBe(0);
    });
  });

  // ── defensive invariants from fromState ────────────────────────────────

  describe('fromState invariants', () => {
    it('throws InvariantViolationError on negative views', () => {
      expect(() => GroupStory.fromState(makeState({ views: -1 }))).toThrow(
        InvariantViolationError,
      );
    });

    it('throws MediaTypeInvalidError on corrupted mediaType', () => {
      expect(() =>
        GroupStory.fromState(makeState({ mediaType: 'audio' as never })),
      ).toThrow(MediaTypeInvalidError);
    });
  });
});
