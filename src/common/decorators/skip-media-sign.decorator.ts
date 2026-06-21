import { SetMetadata } from '@nestjs/common';

/**
 * Opt-out marker read by `MediaSignInterceptor`. Handlers tagged with
 * `@SkipMediaSign()` have their response left untouched — the interceptor
 * will NOT rewrite any `/api/v1/media/<key>` strings into presigned URLs.
 *
 * Use it on endpoints that must return the CANONICAL media URL so the client
 * can persist it (e.g. `POST /admin/content/upload-media`, which hands the
 * client a stable `url`/`key` to attach to a post). Signing those would store
 * an expiring URL in `content_posts.media_urls` and break after the TTL.
 */
export const SKIP_MEDIA_SIGN_KEY = 'skipMediaSign';
export const SkipMediaSign = () => SetMetadata(SKIP_MEDIA_SIGN_KEY, true);
