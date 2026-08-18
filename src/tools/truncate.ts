/**
 * A list result that states its own completeness.
 *
 * A bare array is dangerous in an MCP response: a caller that asks for stalled
 * deals and gets back 100 of 380 has no way to know it saw a quarter of the
 * pipeline, and will happily summarise it as the whole thing. Wrapping the
 * array forces the count and the truncation flag into the response the model
 * actually reads.
 */
export interface TruncatedList<T> {
  items: T[];
  /** How many items are being returned. */
  returned: number;
  /** How many matched in total, before any trimming. */
  total: number;
  truncated: boolean;
  /**
   * Present only when truncated — plain-language instruction, not just a flag.
   *
   * A boolean alone gets ignored: models read prose far more reliably than they
   * read metadata, so the note says in words that the list is partial and what
   * to do about it.
   */
  note?: string;
}

/**
 * Trim a list to `limit` and describe what was trimmed.
 *
 * Unlike the per-server versions this replaces, `limit` is required. The
 * toolkit has no business guessing a page size for an API it knows nothing
 * about — each server passes its own `MAX_RESULT_ITEMS`.
 *
 * @param items          Everything that matched.
 * @param what           Plural noun for the note, e.g. "reviews", "contacts".
 * @param narrowingHint  How the caller should narrow the query, e.g.
 *                       "Filter by rating or a shorter date range to see the rest."
 * @param limit          Maximum items to return. Non-negative integer.
 */
export function truncateList<T>(
  items: readonly T[],
  what: string,
  narrowingHint: string,
  limit: number,
): TruncatedList<T> {
  if (!Number.isInteger(limit) || limit < 0) {
    // A fractional or negative limit is always a callsite bug, and silently
    // coercing it would hand back a wrong `returned` count that reads as truth.
    throw new RangeError(`truncateList: limit must be a non-negative integer, got ${limit}`);
  }

  const total = items.length;
  if (total <= limit) {
    return { items: [...items], returned: total, total, truncated: false };
  }

  const kept = items.slice(0, limit);
  return {
    items: kept,
    returned: kept.length,
    total,
    truncated: true,
    note:
      `Showing the first ${kept.length} of ${total} ${what}. ` +
      `This is a partial list — do not describe it as complete or draw totals from it. ` +
      narrowingHint,
  };
}
