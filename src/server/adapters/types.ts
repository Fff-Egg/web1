import type { Source } from "../db/schema.js";

/**
 * A fetched item, normalized to a common shape before it is written to the
 * `articles` table. `externalId` must be stable for a given item so that the
 * (source_id, external_id) unique constraint dedupes re-fetches.
 */
export interface NormalizedArticle {
  externalId: string;
  url?: string | null;
  title?: string | null;
  body?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
}

/**
 * The common interface every source adapter implements. The collection
 * worker resolves an adapter from the registry by `source.provider` and
 * calls `fetch(source)`.
 */
export interface SourceAdapter {
  provider: string;
  /** Human-friendly description for the UI / logs. */
  label?: string;
  /**
   * Whether this provider requires a stored login session. Used by the UI to
   * decide whether to show the credentialRef / session-status controls.
   */
  requiresAuth?: boolean;
  fetch(source: Source): Promise<NormalizedArticle[]>;
}

/** Thrown by adapters when a stored login session is missing or expired. */
export class SessionRequiredError extends Error {
  constructor(public credentialRef: string, message?: string) {
    super(message ?? `Login session required for "${credentialRef}"`);
    this.name = "SessionRequiredError";
  }
}
