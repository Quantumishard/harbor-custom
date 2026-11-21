import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function load(invoke: (...args: any[]) => Promise<unknown>) {
  const source = readFileSync(
    new URL("../src/lib/music/video-discovery.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputText)(
    (name: string) => {
      assert.equal(name, "@tauri-apps/api/core");
      return { invoke };
    },
    module,
    module.exports,
  );
  return module.exports as typeof import("../src/lib/music/video-discovery.ts");
}
const video = {
  mediaKind: "video",
  videoSearch: false,
  connectorId: "youtube",
  sourceId: "FGBhQbmPwH8",
  id: "youtube:FGBhQbmPwH8",
  title: "One More Time",
  artist: "Daft Punk",
  artwork: "https://i.ytimg.com/vi/FGBhQbmPwH8/hqdefault.jpg",
  durationSeconds: 320,
  durationLabel: "5:20",
};

test("video discovery retains provider identity and rejects wrong sources, malformed IDs and duplicates", () => {
  const api = load(async () => []);
  assert.deepEqual(
    api.musicVideoResults([
      video,
      video,
      { ...video, connectorId: "catalog" },
      { ...video, sourceId: "https://invalid" },
      { ...video, title: "" },
    ]),
    [video],
  );
  assert.deepEqual(api.musicVideoResults(null), []);
  assert.deepEqual(api.musicVideoResults([{ ...video, mediaKind: undefined }]), [video]);
});

test("concurrent discovery shares one bounded request, caches success, and refresh is explicit", async () => {
  const calls: any[] = [];
  let complete!: (data: unknown) => void;
  const api = load((...args) => {
    calls.push(args);
    if (args[0] === "music_video_titles") return Promise.resolve({});
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const searches = () => calls.filter((call) => call[0] === "music_search_videos");
  const one = api.searchMusicVideos(" Daft Punk ");
  const two = api.searchMusicVideos("daft punk");
  assert.equal(searches().length, 1);
  const [command, payload] = calls[0] as [
    string,
    { query: string; limit: number; interviews: boolean },
  ];
  assert.equal(command, "music_search_videos");
  assert.equal(payload.query, "Daft Punk");
  assert.equal(payload.interviews, false);
  assert.ok(
    payload.limit >= 24 && payload.limit <= 48,
    `a music video search asking for only ${payload.limit} leaves More music videos nearly empty, and the native side clamps above 48`,
  );
  complete([video]);
  assert.deepEqual(await one, [video]);
  assert.deepEqual(await two, [video]);
  await api.searchMusicVideos("Daft Punk");
  assert.equal(searches().length, 1);
  const refresh = api.searchMusicVideos("Daft Punk", true);
  assert.equal(searches().length, 2);
  complete([]);
  assert.deepEqual(await refresh, []);
  await api.searchMusicVideos(" ");
  assert.equal(searches().length, 2);
});

test("failed requests are retryable and browsing never invokes playback or stream resolution", async () => {
  const calls: string[] = [];
  const api = load(async (name) => {
    if (name === "music_video_titles") return {};
    calls.push(name);
    if (calls.length === 1) throw Error("offline");
    return [video];
  });
  await assert.rejects(api.searchMusicVideos("videos"), /offline/);
  assert.deepEqual(await api.searchMusicVideos("videos"), [video]);
  assert.deepEqual(calls, ["music_search_videos", "music_search_videos"]);
});

test("a caller that can render more than a rail gets more than a rail, and the default rail is unchanged", async () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    ...video,
    title: `One More Time ${index}`,
    sourceId: `FGBhQbmPw${index.toString().padStart(2, "0")}`,
    id: `youtube:${index}`,
  }));
  const api = load(async () => many);
  assert.equal((await api.searchMusicVideos("daft punk")).length, 12);
  assert.equal((await api.searchMusicVideos("daft punk", false, false, 24)).length, 24);
  assert.equal((await api.searchMusicVideos("daft punk", false, false, 96)).length, 40);
  assert.equal((await api.searchMusicVideos("daft punk", false, false, 0)).length, 12);
});

test("a shared in-flight request still answers each caller at its own size", async () => {
  let complete!: (data: unknown) => void;
  const many = Array.from({ length: 30 }, (_, index) => ({
    ...video,
    title: `One More Time ${index}`,
    sourceId: `AAAAAAAAA${index.toString().padStart(2, "0")}`,
    id: `youtube:${index}`,
  }));
  const api = load((name) =>
    name === "music_video_titles"
      ? Promise.resolve({})
      : new Promise((resolve) => {
          complete = resolve;
        }),
  );
  const rail = api.searchMusicVideos("shared");
  const list = api.searchMusicVideos("shared", false, false, 24);
  complete(many);
  assert.equal((await rail).length, 12);
  assert.equal((await list).length, 24);
});

test("a remix stays a separate entry from the original", async () => {
  const api = load(async () => []);
  assert.notEqual(
    api.musicVideoIdentity("Smart", "LE SSERAFIM"),
    api.musicVideoIdentity("Smart (Remix)", "LE SSERAFIM"),
  );
  // Marketing words still collapse re-uploads of one recording.
  assert.equal(
    api.musicVideoIdentity("Smart (Official Video)", "LE SSERAFIM"),
    api.musicVideoIdentity("Smart", "LE SSERAFIM"),
  );
});

test("the official video outranks remixes and lyric uploads for the same query", async () => {
  const remix = {
    ...video,
    title: "Smart (Remix)",
    sourceId: "BBBBBBBBBBB",
    id: "youtube:BBBBBBBBBBB",
    artist: "Someone",
  };
  const lyrics = {
    ...video,
    title: "Smart Lyrics (Color Coded Lyrics)",
    sourceId: "CCCCCCCCCCC",
    id: "youtube:CCCCCCCCCCC",
    artist: "Lyrics Channel",
  };
  const official = {
    ...video,
    title: "LE SSERAFIM (르세라핌) 'Smart' OFFICIAL MV",
    sourceId: "DDDDDDDDDDD",
    id: "youtube:DDDDDDDDDDD",
    artist: "HYBE LABELS",
  };
  const api = load(async () => [remix, lyrics, official]);
  const ranked = await api.searchMusicVideos("LE SSERAFIM Smart");
  assert.equal(ranked[0].sourceId, "DDDDDDDDDDD", ranked.map((item) => item.title).join("\n"));
  assert.equal(ranked.length, 3, "no version was collapsed away");
});

test("an unrelated song from the same act does not outrank a remix of the requested one", async () => {
  const remix = {
    ...video,
    title: "Smart (Slowed + Reverb ver.)",
    sourceId: "BBBBBBBBBBB",
    id: "youtube:BBBBBBBBBBB",
    artist: "LE SSERAFIM",
  };
  const unrelated = {
    ...video,
    title: "EASY",
    sourceId: "EEEEEEEEEEE",
    id: "youtube:EEEEEEEEEEE",
    artist: "LE SSERAFIM",
  };
  const api = load(async () => [unrelated, remix]);
  const ranked = await api.searchMusicVideos("LE SSERAFIM Smart");
  assert.equal(ranked[0].sourceId, "BBBBBBBBBBB", ranked.map((item) => item.title).join("\n"));
});

test("an upload that repeats the act name does not outrank the official song", async () => {
  // Real provider data for "LE SSERAFIM Smart".
  const official = {
    ...video,
    title: "Smart",
    sourceId: "05VSCSna5WA",
    id: "youtube:05VSCSna5WA",
    artist: "LE SSERAFIM",
  };
  const cover = {
    ...video,
    title: "LE SSERAFIM - Smart || English Cover by SERRI",
    sourceId: "vLt01gxlMI0",
    id: "youtube:vLt01gxlMI0",
    artist: "Serri",
  };
  const slowed = {
    ...video,
    title: "Smart (Slowed + Reverb ver.)",
    sourceId: "KNexS61fjus",
    id: "youtube:KNexS61fjus",
    artist: "LE SSERAFIM",
  };
  const unrelated = {
    ...video,
    title: "EASY",
    sourceId: "sx571AlI27k",
    id: "youtube:sx571AlI27k",
    artist: "LE SSERAFIM",
  };
  const api = load(async () => [slowed, cover, unrelated, official]);
  const ranked = await api.searchMusicVideos("LE SSERAFIM Smart");
  assert.deepEqual(
    ranked.map((item) => item.sourceId),
    ["05VSCSna5WA", "KNexS61fjus", "vLt01gxlMI0", "sx571AlI27k"],
    ranked.map((item) => item.title).join("\n"),
  );
});
test("a bare word search puts title matches above an artist-name match", async () => {
  // Real provider order for the query "Smart".
  const rahul = {
    ...video,
    title: "#Video - #Rahul Jadeja",
    sourceId: "rrrrrrrrrrr",
    id: "youtube:rrrrrrrrrrr",
    artist: "Rahul Jadeja",
  };
  const stage = {
    ...video,
    title: "Smart #엠카운트다운 EP.832 | Mnet 240307 방송",
    sourceId: "sssssssssss",
    id: "youtube:sssssssssss",
    artist: "LE SSERAFIM",
  };
  const playIt = {
    ...video,
    title: "Play It Smart",
    sourceId: "ppppppppppp",
    id: "youtube:ppppppppppp",
    artist: "LPB Poody",
  };
  const crazy = {
    ...video,
    title: "Smart Went Crazy",
    sourceId: "ccccccccccc",
    id: "youtube:ccccccccccc",
    artist: "Ant",
  };
  const api = load(async () => [rahul, stage, playIt, crazy]);
  const page = await api.searchMusicVideos("Smart");
  assert.deepEqual(
    page.map((item) => item.sourceId),
    ["sssssssssss", "ppppppppppp", "ccccccccccc", "rrrrrrrrrrr"],
    page.map((item) => item.title).join("\n"),
  );
});
test("a provider-mislabelled video takes YouTube own title", async () => {
  const mislabelled = {
    ...video,
    title: "Smart (Slowed + Reverb ver.)",
    sourceId: "KNexS61fjus",
    id: "youtube:KNexS61fjus",
    artist: "LE SSERAFIM",
  };
  const calls = [];
  const api = load(async (command, args) => {
    calls.push({ command, args });
    if (command === "music_video_titles")
      return { KNexS61fjus: "LE SSERAFIM (르세라핌) 'Smart' OFFICIAL MV" };
    return [mislabelled];
  });
  const [first] = await api.searchMusicVideos("LE SSERAFIM Smart");
  assert.equal(first.title, "LE SSERAFIM (르세라핌) 'Smart' OFFICIAL MV");
  assert.equal(first.sourceId, "KNexS61fjus");
  const [second] = await api.searchMusicVideos("LE SSERAFIM Smart", true);
  assert.equal(second.title, "LE SSERAFIM (르세라핌) 'Smart' OFFICIAL MV");
  assert.equal(
    calls.filter((call) => call.command === "music_video_titles").length,
    1,
    "one lookup per id per session",
  );
});
test("the corrected official video outranks the label source upload", async () => {
  const source = {
    ...video,
    title: "Smart",
    sourceId: "05VSCSna5WA",
    id: "youtube:05VSCSna5WA",
    artist: "LE SSERAFIM",
  };
  const mislabelled = {
    ...video,
    title: "Smart (Slowed + Reverb ver.)",
    sourceId: "KNexS61fjus",
    id: "youtube:KNexS61fjus",
    artist: "LE SSERAFIM",
  };
  const api = load(async (command) => {
    if (command === "music_video_titles")
      return { KNexS61fjus: "LE SSERAFIM (르세라핌) 'Smart' OFFICIAL MV" };
    return [source, mislabelled];
  });
  const ranked = await api.searchMusicVideos("LE SSERAFIM Smart");
  assert.deepEqual(
    ranked.map((item) => item.sourceId),
    ["KNexS61fjus", "05VSCSna5WA"],
    ranked.map((item) => item.title).join("\n"),
  );
});
test("a bare song name is anchored to the playing artist", async () => {
  const api = load(async () => []);
  const playing = { ...video, title: "Gnarly", artist: "KATSEYE" };
  assert.equal(api.anchoredVideoQuery("Gnarly", playing), "KATSEYE Gnarly");
  assert.equal(api.anchoredVideoQuery("gnarly", playing), "KATSEYE gnarly");
  assert.equal(api.anchoredVideoQuery("Gnarly Katseye", playing), "Gnarly Katseye");
  assert.equal(api.anchoredVideoQuery("Gnarly", { ...video, title: "Other" }), "Gnarly");
  assert.equal(api.anchoredVideoQuery("Gnarly", null), "Gnarly");
});
test("the song's own upload leads a bare word search over stage clips", async () => {
  const stage = {
    ...video,
    title: "좋은 곡과 KATSEYE - Gnarly (Clean ver.) #엠카운트다운 EP.883",
    sourceId: "sssssssssss",
    id: "youtube:sssssssssss",
    artist: "KATSEYE",
  };
  const official = {
    ...video,
    title: "Gnarly",
    sourceId: "946yGX5o-Js",
    id: "youtube:946yGX5o-Js",
    artist: "KATSEYE",
  };
  const other = {
    ...video,
    title: "Debut MV (Choreography Ver.) | KATSEYE",
    sourceId: "ddddddddddd",
    id: "youtube:ddddddddddd",
    artist: "KATSEYE",
  };
  const api = load(async () => [stage, other, official]);
  const ranked = await api.searchMusicVideos("Gnarly");
  assert.deepEqual(
    ranked.map((item) => item.sourceId),
    ["946yGX5o-Js", "sssssssssss", "ddddddddddd"],
    ranked.map((item) => item.title).join("\n"),
  );
});
