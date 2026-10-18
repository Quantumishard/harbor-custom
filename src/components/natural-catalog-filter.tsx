import { useEffect, useRef, useState } from "react";
import type { BrowseCatalog } from "@/lib/catalog-browse";
import { browseFetcher } from "@/lib/catalog-browse";
import type { Meta } from "@/lib/cinemeta";
import { allowDirectHost, safeFetch } from "@/lib/safe-fetch";

type Fetcher = (page: number, loaded?: number) => Promise<Meta[]>;
type Result = {
  metas: Meta[];
  naturalFilter?: {
    status: "planning" | "scanning" | "complete" | "partial" | "error";
    scanned: number;
    unknown: number;
    total: number;
    summary?: string;
    error?: string;
  };
};

export function NaturalCatalogFilter({
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
  const [stopping, setStopping] = useState(false);
  const stopRequested = useRef(false);
  const [applied, setApplied] = useState(false);
  const revision = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      revision.current++;
      abort.current?.abort();
    },
    [],
  );

  const read = async (
    text: string,
    skip: number,
    signal?: AbortSignal,
    stop = false,
  ): Promise<Result> => {
    const params = new URLSearchParams({ nlFilter: text, skip: String(skip) });
    if (stop) params.set("nlAction", "stop");
    if (genre && catalog.genreExtra) params.set(catalog.genreExtra, genre);
    const url = `${catalog.base}/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}/${params.toString()}.json`;
    allowDirectHost(url);
    const response = await safeFetch(url, { signal: signal ?? AbortSignal.timeout(20000) });
    if (!response.ok)
      throw Error("Catalog filter unavailable. Check the AIOMetadata connection and retry.");
    const data = (await response.json()) as Result;
    if (!data.naturalFilter)
      throw Error("This AIOMetadata server needs the catalog filter update.");
    if (data.naturalFilter.status === "error")
      throw Error(data.naturalFilter.error || "Filtering failed.");
    return data;
  };
  const clear = () => {
    revision.current++;
    abort.current?.abort();
    setBusy(false);
    setStopping(false);
    stopRequested.current = false;
    setApplied(false);
    setQuery("");
    setMessage("");
    onApply(browseFetcher(catalog, genre));
  };
  const apply = async () => {
    const text = query.trim();
    if (!text) return;
    const current = ++revision.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    stopRequested.current = false;
    setStopping(false);
    setBusy(true);
    setMessage("Interpreting filter…");
    try {
      for (;;) {
        const data = await read(text, 0, controller.signal, stopRequested.current);
        if (revision.current !== current) return;
        const state = data.naturalFilter!;
        if (state.status === "complete" || state.status === "partial") {
          setMessage(
            `${state.status === "partial" ? "Partial results — " : ""}${state.summary || "Scan stopped"} · ${state.total} matches from ${state.scanned} checked titles${state.status === "partial" ? ". Sorting covers only checked titles; unscanned titles may contain better matches." : ""}${state.unknown ? ` · ${state.unknown} excluded because required metadata was missing` : ""}`,
          );
          setApplied(true);
          onApply(async (page, loaded) => {
            const result = await read(text, loaded ?? (page - 1) * 100);
            if (
              result.naturalFilter?.status !== "complete" &&
              result.naturalFilter?.status !== "partial"
            )
              throw Error("Filter cache expired. Apply the filter again.");
            return result.metas;
          });
          return;
        }
        setMessage(
          `${state.summary || "Interpreting filter…"}${state.status === "scanning" ? ` · Checked ${state.scanned} titles; ${state.total} matches so far` : ""}`,
        );
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            controller.signal.removeEventListener("abort", stop);
            resolve();
          }, 1500);
          const stop = () => {
            window.clearTimeout(timer);
            reject(Error("Cancelled"));
          };
          controller.signal.addEventListener("abort", stop, { once: true });
        });
      }
    } catch (e) {
      if (revision.current === current)
        setMessage(e instanceof Error ? e.message : "Filtering failed.");
    } finally {
      if (revision.current === current) {
        setBusy(false);
        setStopping(false);
      }
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
      className="flex flex-col gap-2 rounded-2xl border border-edge-soft bg-elevated/30 p-4"
    >
      <label htmlFor="natural-catalog-filter" className="text-sm font-medium text-ink">
        Filter this catalog
      </label>
      <div className="flex gap-2">
        <input
          id="natural-catalog-filter"
          value={query}
          maxLength={1000}
          readOnly={busy}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Documentaries since 2020, rated at least 7, most IMDb votes first"
          className="min-w-0 flex-1 rounded-lg bg-canvas px-3 py-2 text-sm text-ink outline-none ring-1 ring-edge-soft focus:ring-edge"
        />
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="rounded-lg bg-ink px-4 py-2 text-sm text-canvas disabled:opacity-50"
        >
          {busy ? "Filtering…" : "Apply"}
        </button>
        {busy && (
          <button
            type="button"
            disabled={stopping}
            onClick={() => {
              stopRequested.current = true;
              setStopping(true);
              setMessage("Stopping and preparing partial results…");
            }}
            className="rounded-lg bg-elevated px-3 py-2 text-sm text-ink disabled:opacity-50"
          >
            {stopping ? "Stopping…" : "Stop and show results"}
          </button>
        )}
        {(busy || applied || message) && (
          <button type="button" onClick={clear} className="rounded-lg px-3 py-2 text-sm text-ink">
            {busy ? "Cancel" : "Clear"}
          </button>
        )}
      </div>
      <p aria-live="polite" role="status" className="text-xs text-ink-muted">
        {message ||
          "Filters the selected catalog. Large catalogs can take several minutes on the first scan. Subject filters match plot text and keywords."}
      </p>
    </form>
  );
}
