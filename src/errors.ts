/**
 * errors.ts — the shared error type.
 *
 * Kept in its own file so both scraper.ts and renderer.ts can import it without
 * creating a circular dependency between them.
 */

/**
 * A small, custom error type so callers can show friendly messages instead of
 * leaking raw stack traces to the end user.
 */
export class ScrapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeError";
  }
}
