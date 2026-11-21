/**
 * Flatten the original checkpoints from nested Continue Watching groups.
 *
 * Provider/local deduplication can itself produce cwMembers, and franchise
 * grouping can wrap it in another group. Dismissal must see each real source,
 * not a synthetic intermediate card.
 */
type SourceRow = {
  _id: string;
  cwMembers?: unknown;
  _mtime?: string | number;
  state?: { season?: number; episode?: number; video_id?: string; lastWatched?: string };
};

function checkpointStamp(row: SourceRow): number {
  const seen = Date.parse(row.state?.lastWatched ?? "");
  if (Number.isFinite(seen)) return seen;
  const stamp = typeof row._mtime === "number" ? row._mtime : Date.parse(String(row._mtime ?? ""));
  return Number.isFinite(stamp) ? stamp : 0;
}

export function flattenCwSourceMembers<T extends SourceRow>(rows: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Map<string, number>();
  const visited = new Set<object>();

  function visit(row: T): void {
    if (!row || visited.has(row)) return;
    visited.add(row);
    const children = row.cwMembers;
    if (Array.isArray(children) && children.length > 0) {
      for (const child of children as T[]) visit(child);
      return;
    }
    const source = row as T & {
      external?: string;
      local?: boolean;
      manualWatched?: boolean;
      providerPlaybackIds?: Record<string, string | number | undefined>;
    };
    const playbackIds = Object.entries(source.providerPlaybackIds ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, id]) => `${provider}:${id ?? ""}`).join(",");
    const key = [
      row._id, source.external ?? "", source.local ? "local" : "",
      source.manualWatched ? "manual" : "",
      row.state?.season ?? "", row.state?.episode ?? "",
      row.state?.video_id ?? "", playbackIds,
    ].join("\u001f");
    const held = seen.get(key);
    if (held === undefined) {
      seen.set(key, out.length);
      out.push(row);
    } else if (checkpointStamp(row) > checkpointStamp(out[held]!)) {
      out[held] = row;
    }
  }

  for (const row of rows) visit(row);
  return out;
}
