import type { RankedPicker, Stream } from "./types";

const MARKER = "#harbor-easynews-nzb";

export function isEasynewsHttpUrl(raw: string | undefined): boolean {
  try {
    const url = new URL(raw ?? "");
    return (
      /^https?:$/.test(url.protocol) &&
      /(^|\.)easynews\.com$/i.test(url.hostname) &&
      !url.port &&
      !!url.username &&
      /\/[a-f0-9]{32,64}\.[a-z0-9]+\/[^/]+$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isEasynewsNzbOption(stream: Pick<Stream, "url">): boolean {
  return !!stream.url?.endsWith(MARKER) && isEasynewsHttpUrl(stream.url);
}

/** Add choices after ranking so URL deduplication cannot collapse the transports. */
export function withEasynewsNzbOptions(picker: RankedPicker): RankedPicker {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return picker;
  const existing = new Set(picker.all.filter(isEasynewsNzbOption).map((stream) => stream.url));
  return {
    ...picker,
    all: picker.all.flatMap((stream) => {
      if (!isEasynewsHttpUrl(stream.url) || isEasynewsNzbOption(stream)) return [stream];
      const url = new URL(stream.url!);
      url.hash = MARKER;
      if (existing.has(url.href)) return [stream];
      return [
        stream,
        {
          ...stream,
          url: url.href,
          name: "Easynews NZB via AIOStreams",
          addonName: `${stream.addonName} · NZB via AIOStreams`,
          behaviorHints: { ...stream.behaviorHints, bingeGroup: "harbor-easynews-nzb" },
        },
      ];
    }),
  };
}
