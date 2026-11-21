import { useEffect, useRef, useState } from "react";
import type { Meta } from "@/lib/cinemeta";
import { FeedShelf } from "@/components/feed-shelf";
import { useHideAnimeMetas } from "@/lib/anime-hide";
import { browseFetcher, catalogTypeLabelKey, type BrowseCatalog } from "@/lib/catalog-browse";
import { useView } from "@/lib/view";
import { useT } from "@/lib/i18n";

export function CatalogShelf({ catalog }: { catalog: BrowseCatalog }) {
  const { openGrid } = useView();
  const t = useT();
  const typeLabelKey = catalogTypeLabelKey(catalog.type);
  const [items, setItems] = useState<Meta[] | null>(null);
  const pagination = useRef<{
    fetchPage: ReturnType<typeof browseFetcher>;
    page: number;
    offset: number;
    items: Meta[];
    loading: boolean;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setItems(null);
    const el = ref.current;
    if (!el) return;
    let observing = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!observing || !entries.some((e) => e.isIntersecting)) return;
        observing = false;
        io.disconnect();
        const shelf = {
          fetchPage: browseFetcher(catalog, null),
          page: 1,
          offset: 0,
          items: [] as Meta[],
          loading: true,
        };
        pagination.current = shelf;
        void shelf.fetchPage(1).then(
          (list) => {
            if (pagination.current !== shelf) return;
            shelf.items = list;
            shelf.offset = list.length;
            shelf.loading = false;
            setItems(list);
          },
          () => {
            if (pagination.current === shelf) setItems([]);
          },
        );
      },
      { rootMargin: "700px 0px" },
    );
    io.observe(el);
    return () => {
      observing = false;
      io.disconnect();
      pagination.current = null;
    };
  }, [catalog.key]);

  const loadMore = () => {
    const shelf = pagination.current;
    if (!shelf || shelf.loading) return;
    const next = shelf.page + 1;
    shelf.loading = true;
    void shelf
      .fetchPage(next, shelf.offset)
      .then((list) => {
        if (pagination.current !== shelf || list.length === 0) return;
        shelf.page = next;
        // The provider cursor counts every entry, including duplicates hidden by the shelf.
        shelf.offset += list.length;
        const seen = new Set(shelf.items.map((m) => m.id));
        const fresh = list.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        if (fresh.length === 0) return;
        shelf.items = [...shelf.items, ...fresh];
        setItems(shelf.items);
      })
      .catch(() => {})
      .finally(() => {
        shelf.loading = false;
      });
  };

  const shownItems = useHideAnimeMetas(items ?? []);
  if (items !== null && shownItems.length === 0) return null;

  return (
    <div ref={ref}>
      <FeedShelf
        shelf={{
          id: catalog.key,
          title: catalog.name,
          kicker: typeLabelKey ? t(typeLabelKey) : catalog.type,
        }}
        items={items === null ? null : shownItems}
        onEndReached={loadMore}
        scrollKey={`catalogs:${catalog.key}`}
        onViewAll={() =>
          openGrid({
            title: catalog.name,
            naturalCatalog: catalog.naturalFilterSupported ? catalog : undefined,
            fetcher: browseFetcher(catalog, null),
            initial: items ?? undefined,
            filter:
              catalog.genres.length > 0
                ? {
                    label: t("Filter"),
                    options: [
                      {
                        value: "",
                        label: t("All genres"),
                        fetcher: browseFetcher(catalog, null),
                        initial: items ?? undefined,
                      },
                      ...catalog.genres.map((genre) => ({
                        value: genre,
                        label: genre,
                        fetcher: browseFetcher(catalog, genre),
                      })),
                    ],
                  }
                : undefined,
          })
        }
      />
    </div>
  );
}
