import assert from "node:assert/strict";
import test from "node:test";

import { setIdentityInvoker } from "../src/lib/identity/client.ts";
import { clearIdentityCardCache } from "../src/lib/identity/card-grouping.ts";
import { resetIdentityFlags, setIdentityFlags } from "../src/lib/identity/flags.ts";
import {
  clearIdentityMisKeyCache,
  isIdentityMisKeyRetired,
  warmIdentityMisKey,
} from "../src/lib/identity/mis-key.ts";

function reset(): void {
  resetIdentityFlags();
  setIdentityInvoker(null);
  clearIdentityCardCache();
  clearIdentityMisKeyCache();
}

function mockIdentity(): void {
  setIdentityInvoker(async (command, args) => {
    if (command === "identity_card_hints") {
      const ids = (args as { ids: string[] }).ids;
      return ids.map((id) => {
        if (id === "mal:14719") {
          return {
            id,
            entry: 1,
            title: "JoJo 2012",
            mediaType: "TV",
            cardKey: "tvdb:262954",
            windows: [
              {
                anidb: 9304,
                tvdb: 262954,
                tmdbtv: 45790,
                tvdbSeason: 1,
                tvdbOffset: null,
                tmdbSeason: 1,
                tmdbOffset: null,
              },
            ],
            tvdb: 262954,
            tmdb: 45790,
            season: 1,
            offset: 0,
            provisional: false,
          };
        }
        return {
          id,
          entry: 2,
          title: "Steel Ball Run",
          mediaType: "ONA",
          cardKey: "tvdb:262954",
          windows: [
            {
              anidb: 19287,
              tvdb: 262954,
              tmdbtv: 45790,
              tvdbSeason: 6,
              tvdbOffset: null,
              tmdbSeason: 6,
              tmdbOffset: null,
            },
          ],
          tvdb: 262954,
          tmdb: 45790,
          season: 6,
          offset: 0,
          provisional: false,
        };
      });
    }
    if (command === "identity_window_owners") {
      const payload = args as { season: number };
      if (payload.season === 6) {
        return [
          {
            entry: 2,
            title: "Steel Ball Run",
            mediaType: "ONA",
            tvdb: 262954,
            tmdb: 45790,
            season: 6,
            offset: 0,
          },
        ];
      }
      return [];
    }
    return null;
  });
}

test("a row whose checkpoint belongs to another entry is retired", async () => {
  reset();
  setIdentityFlags({ pack: true, cards: true });
  mockIdentity();

  const stale = { _id: "mal:14719", state: { season: 6, lastWatched: "2026-11-16T14:40:00Z" } };
  const changed = await warmIdentityMisKey([stale]);

  assert.equal(changed, true);
  assert.equal(isIdentityMisKeyRetired("mal:14719"), true);
});

test("a row that owns its checkpoint season is not retired", async () => {
  reset();
  setIdentityFlags({ pack: true, cards: true });
  mockIdentity();

  const own = { _id: "kitsu:49847", state: { season: 6, lastWatched: "2026-11-16T20:10:00Z" } };
  const changed = await warmIdentityMisKey([own]);

  assert.equal(changed, false);
  assert.equal(isIdentityMisKeyRetired("kitsu:49847"), false);
});

test("rows without windows or with a provisional identity stay untouched", async () => {
  reset();
  setIdentityFlags({ pack: true, cards: true });
  setIdentityInvoker(async (command) => {
    if (command === "identity_card_hints") {
      return [
        {
          id: "kitsu:99999",
          entry: 9,
          title: "No windows",
          mediaType: "TV",
          cardKey: null,
          windows: [],
          tvdb: null,
          tmdb: null,
          season: null,
          offset: null,
          provisional: true,
        },
      ];
    }
    return [];
  });

  assert.equal(await warmIdentityMisKey([{ _id: "kitsu:99999", state: { season: 2 } }]), false);
  assert.equal(isIdentityMisKeyRetired("kitsu:99999"), false);
});

test("ambiguous window ownership does not retire a row", async () => {
  reset();
  setIdentityFlags({ pack: true, cards: true });
  setIdentityInvoker(async (command, args) => {
    if (command === "identity_card_hints") {
      const ids = (args as { ids: string[] }).ids;
      return ids.map((id) => ({
        id,
        entry: 1,
        title: "JoJo 2012",
        mediaType: "TV",
        cardKey: "tvdb:262954",
        windows: [
          {
            anidb: 9304,
            tvdb: 262954,
            tmdbtv: 45790,
            tvdbSeason: 1,
            tvdbOffset: null,
            tmdbSeason: 1,
            tmdbOffset: null,
          },
        ],
        tvdb: 262954,
        tmdb: 45790,
        season: 1,
        offset: 0,
        provisional: false,
      }));
    }
    if (command === "identity_window_owners") {
      return [
        { entry: 2, title: "A", mediaType: "ONA", tvdb: 262954, tmdb: 45790, season: 6, offset: 0 },
        { entry: 3, title: "B", mediaType: "TV", tvdb: 262954, tmdb: 45790, season: 6, offset: 0 },
      ];
    }
    return null;
  });

  const changed = await warmIdentityMisKey([{ _id: "mal:14719", state: { season: 6 } }]);
  assert.equal(changed, false);
  assert.equal(isIdentityMisKeyRetired("mal:14719"), false);
});
