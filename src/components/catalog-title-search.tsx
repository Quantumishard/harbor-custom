import { useEffect, useRef, useState } from "react";
import { browseFetcher, type BrowseCatalog } from "@/lib/catalog-browse";
import { CatalogTitleIndex } from "@/lib/catalog-title-search";
import type { Meta } from "@/lib/cinemeta";

type Fetcher = (page: number, loaded?: number) => Promise<Meta[]>;

export function CatalogTitleSearch({
  catalog,
  genre,
  onApply,
}: {
  catalog: BrowseCatalog;
  genre: string | null;
  onApply: (fetcher: Fetcher) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const revision = useRef(0);
  const index = useRef<CatalogTitleIndex | null>(null);
  index.current ??= new CatalogTitleIndex(browseFetcher(catalog, genre));
  useEffect(
    () => () => {
      revision.current++;
    },
    [],
  );

  const apply = async () => {
    const text = query.trim();
    if (!text || busy) return;
    const current = ++revision.current;
    const titles = index.current!;
    setBusy(true);
    try {
      while (!titles.complete) {
        setMessage(`Loading catalog titles… ${titles.size.toLocaleString()} checked`);
        await titles.next();
        if (revision.current !== current) return;
      }
      const matches = titles.search(text);
      setMessage(
        `${matches.length.toLocaleString()} matches · ${titles.size.toLocaleString()} catalog titles searched`,
      );
      onApply(async (page, loaded) => {
        const start = loaded ?? (page - 1) * 100;
        return matches.slice(start, start + 100);
      });
    } catch (error) {
      if (revision.current === current)
        setMessage(error instanceof Error ? error.message : "Title search failed. Retry.");
    } finally {
      if (revision.current === current) setBusy(false);
    }
  };
  const clear = () => {
    revision.current++;
    setBusy(false);
    setQuery("");
    setMessage("");
    onApply(browseFetcher(catalog, genre));
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
      className="flex flex-col gap-2 rounded-2xl border border-edge-soft bg-elevated/30 p-4"
    >
      <label htmlFor="catalog-title-search" className="text-sm font-medium text-ink">
        Search this catalog by displayed title only
      </label>
      <div className="flex gap-2">
        <input
          id="catalog-title-search"
          value={query}
          maxLength={300}
          readOnly={busy}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Enter part of a displayed title"
          className="min-w-0 flex-1 rounded-lg bg-canvas px-3 py-2 text-sm text-ink outline-none ring-1 ring-edge-soft focus:ring-edge"
        />
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="rounded-lg bg-ink px-4 py-2 text-sm text-canvas disabled:opacity-50"
        >
          {busy ? "Searching…" : "Search"}
        </button>
        {(query || message) && (
          <button type="button" onClick={clear} className="rounded-lg px-3 py-2 text-sm text-ink">
            {busy ? "Cancel" : "Clear"}
          </button>
        )}
      </div>
      <p aria-live="polite" role="status" className="text-xs text-ink-muted">
        {message ||
          "Searches the entire selected catalog by title text only. Titles are loaded once and reused for fast searches. Case-insensitive; enter any part of a title."}
      </p>
    </form>
  );
}
