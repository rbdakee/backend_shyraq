/**
 * Stream keys are typed by hand into the admin panel and then interpolated
 * into a media-gateway URL, so the charset is kept to what a gateway stream
 * name can legitimately contain. Anything that would need escaping in a query
 * string — spaces, slashes, `&`, `?` — is rejected at the edge rather than
 * encoded later.
 */
export const STREAM_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
