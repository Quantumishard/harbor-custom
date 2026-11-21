export type IdentityLookup = {
  id: string;
  entry: number | null;
  title: string | null;
  provisional: boolean;
};

export type IdentityStatus = {
  ready: boolean;
  dbBytes: number;
  packVersion: string | null;
  upstreamSha256: string | null;
  builtAt: number | null;
  entries: number;
  windows: number;
  schema: number;
};

export type IdentityAlias = { scheme: string; id: string };

export type IdentityRelated = { entry: number; title: string | null };

export type IdentityWindow = {
  anidb: number | null;
  tvdb: number | null;
  tmdbtv: number | null;
  tvdbSeason: number | null;
  tvdbOffset: number | null;
  tmdbSeason: number | null;
  tmdbOffset: number | null;
};

export type IdentityCardHint = {
  id: string;
  entry: number | null;
  title: string | null;
  mediaType: string | null;
  cardKey: string | null;
  windows?: IdentityWindow[];
  tvdb: number | null;
  tmdb: number | null;
  season: number | null;
  offset: number | null;
  provisional: boolean;
};

export type IdentityBundle = {
  entry: number;
  title: string | null;
  mediaType: string | null;
  episodes: number | null;
  aliases: IdentityAlias[];
  related: IdentityRelated[];
  windows: IdentityWindow[];
};

export type IdentityFlags = {
  pack: boolean;
  shadow: boolean;
  cards: boolean;
};

export const IDENTITY_FLAG_DEFAULTS: IdentityFlags = { pack: false, shadow: false, cards: false };

export type IdentityWindowOwner = {
  entry: number;
  title: string | null;
  mediaType: string | null;
  tvdb: number | null;
  tmdb: number | null;
  season: number | null;
  offset: number | null;
};
