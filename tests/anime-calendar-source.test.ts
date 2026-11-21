// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";

class FakeAniListError extends Error {
  status: number;
  isAuthenticationError: boolean;
  constructor(status: number, isAuthenticationError = false) {
    super("AniList HTTP " + status);
    this.status = status;
    this.isAuthenticationError = isAuthenticationError;
  }
}

function load(path: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api: Record<string, unknown> = {};
  new Function("require", "exports", code)((id: string) => {
    assert.ok(id in mocks, "unexpected dependency " + id);
    return mocks[id];
  }, api);
  return api;
}

const entry = (episode: number, day: number) => ({
  airingAt: Date.parse(`2026-11-${String(day).padStart(2, "0")}T12:00:00Z`) / 1000,
  episode,
  media: {
    id: 990389,
    idMal: 990181,
    type: "ANIME",
    isAdult: false,
    format: "TV",
    title: { english: "Sequel Test Anime", romaji: null },
    coverImage: { large: null, extraLarge: null },
    bannerImage: null,
    averageScore: null,
    description: null,
  },
});

type AiringRequest = (variables: { page: number }, anonymous: boolean) => Promise<unknown>;
function calendar(request: AiringRequest) {
  const api = load("src/lib/anilist/airing.ts", {
    "./client": {
      AnilistApiError: FakeAniListError,
      anilistRequest: async (
        _query: string,
        variables: { page: number },
        _token: unknown,
        anonymous: boolean,
      ) => request(variables, anonymous),
    },
    "@/lib/calendar-time": {
      toLocalDateISO: (date: Date) => date.toISOString().slice(0, 10),
      toLocalTimeLabel: () => "12:00 PM",
    },
  });
  return api.fetchAniListAiringCalendar as (
    year: number,
    month: number,
  ) => Promise<Array<{ id: string; releaseDate: string }>>;
}

test("anime calendar fetches subsequent pages in order", async () => {
  const calls: number[] = [];
  const anonymousFlags: boolean[] = [];
  const run = calendar(async ({ page }, anonymous) => {
    calls.push(page);
    anonymousFlags.push(anonymous);
    return {
      Page: {
        airingSchedules: [entry(page, page + 4)],
        pageInfo: { hasNextPage: page < 2 },
      },
    };
  });
  const rows = await run(2026, 10);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(anonymousFlags, [false, false]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["mal:990181:1:1", "mal:990181:1:2"],
  );
});

test("anime calendar retries anonymously only if the signed-in token expired", async () => {
  const flags: boolean[] = [];
  const run = calendar(async ({ page }, anonymous) => {
    flags.push(anonymous);
    if (page === 1 && !anonymous) throw new FakeAniListError(401, true);
    return {
      Page: {
        airingSchedules: [entry(page, page + 3)],
        pageInfo: { hasNextPage: page < 2 },
      },
    };
  });
  assert.equal((await run(2026, 10)).length, 2);
  assert.deepEqual(flags, [false, true, true]);
});

test("rate limits and later-page errors are not mistaken for empty months", async () => {
  const rateLimited = calendar(async () => {
    throw new FakeAniListError(429);
  });
  await assert.rejects(rateLimited(2026, 10), /rate-limiting/);
  const laterFailure = calendar(async ({ page }) => {
    if (page === 2) throw new Error("network failure");
    return { Page: { airingSchedules: [entry(1, 5)], pageInfo: { hasNextPage: true } } };
  });
  await assert.rejects(laterFailure(2026, 10), /network failure/);
});

test("a failed AniList calendar fetch is retried instead of cached as empty", async () => {
  let calls = 0;
  const api = load("src/lib/calendar-sources.ts", {
    "./calendar-time": {
      localDateTimeFromIso: () => ({ date: "" }),
      toLocalDateISO: () => "",
      toLocalTimeLabel: () => "",
    },
    "./anilist/airing": {
      fetchAniListAiringCalendar: async () => {
        calls++;
        if (calls === 1) throw new Error("rate limit");
        return [{ id: "mal:990181:1:1" }];
      },
    },
  }) as {
    fetchAniListAiringCalendar: (year: number, month: number) => Promise<Array<{ id: string }>>;
  };
  await assert.rejects(api.fetchAniListAiringCalendar(2026, 10), /rate limit/);
  assert.equal((await api.fetchAniListAiringCalendar(2026, 10))[0].id, "mal:990181:1:1");
  assert.equal(calls, 2);
});
