import { useState } from "react";
import { MANGA_COLLECTIONS, streamCollection } from "@/lib/manga/collections";
import { useT } from "@/lib/i18n";
import type { MangaSummary } from "@/lib/manga/types";
import { badgeArtFor } from "./collection-badge";
import { MangaRail } from "./manga-rail";
import { MangaMatchPicker } from "@/views/collections/manga-match-picker";

export function MangaCollections({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  // Collection rows resolve to one source's copy already; let the user pick
  // which extension's copy to open instead of trusting that guess.
  const [pickTitle, setPickTitle] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-9">
      {MANGA_COLLECTIONS.map((collection) => (
        <MangaRail
          key={collection.id}
          title={t(collection.name)}
          subtitle={collection.subtitle ? t(collection.subtitle) : undefined}
          scrollKey={`manga:${collection.name}`}
          art={badgeArtFor(collection.id)}
          award={collection.award}
          loadStream={(onChunk) => streamCollection(collection, onChunk)}
          onOpen={(item: MangaSummary) => setPickTitle(item.title)}
        />
      ))}
      {pickTitle && (
        <MangaMatchPicker
          name={pickTitle}
          onSelect={(id) => {
            setPickTitle(null);
            onOpen(id);
          }}
          onClose={() => setPickTitle(null)}
        />
      )}
    </div>
  );
}
