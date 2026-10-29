import type { Meta } from "./cinemeta";

type Fetcher = (page: number, loaded?: number) => Promise<Meta[]>;

/** One lightweight catalog scan, reused for every query until the catalog changes. */
export class CatalogTitleIndex {
  private entries: { meta: Meta; title: string }[] = [];
  private seen = new Set<string>();
  private page = 0;
  private loaded = 0;
  complete = false;
  private pending: Promise<void> | undefined;

  constructor(private fetcher: Fetcher) {}

  get size(): number {
    return this.entries.length;
  }

  next(): Promise<void> {
    return (this.pending ??= this.load().finally(() => {
      this.pending = undefined;
    }));
  }

  private async load(): Promise<void> {
    if (this.complete) return;
    const batch = await this.fetcher(this.page + 1, this.loaded);
    if (!batch.length) {
      this.complete = true;
      return;
    }
    const fresh = batch.filter((meta) => !this.seen.has(meta.id));
    if (!fresh.length)
      throw Error(
        "The catalog repeated a page. The full catalog could not be searched; retry later.",
      );
    this.page++;
    this.loaded += batch.length;
    for (const meta of fresh) {
      if (this.seen.has(meta.id)) continue;
      this.seen.add(meta.id);
      this.entries.push({ meta, title: meta.name.toLocaleLowerCase() });
    }
  }

  search(query: string): Meta[] {
    const text = query.trim().toLocaleLowerCase();
    return this.entries.filter((entry) => entry.title.includes(text)).map((entry) => entry.meta);
  }
}
