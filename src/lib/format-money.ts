/**
 * Condensed USD for metadata rows: $1.8B, $250M, $750K.
 * TMDB reports absolute dollars, so each branch divides by its own unit.
 */
export function compactUsd(value?: number): string | null {
  if (!value || value <= 0) return null;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${Math.round(value / 1_000_000)}M`;
  return `$${Math.round(value / 1_000)}K`;
}
