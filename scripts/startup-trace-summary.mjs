#!/usr/bin/env node
// Summarizes a copied Harbor startup trace (`__harborStartup.export()`).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function latestTrace(trace, previous) {
  if (!previous) return true;
  return (trace?.at ?? 0) > (previous?.at ?? 0);
}

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

function summary(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function cwCategory(trace) {
  const events = Array.isArray(trace.events) ? trace.events : [];
  const ready = events.find((event) => event?.name === "cw.cache.ready");
  const items = Number(ready?.detail?.items ?? 0);
  if (!Number.isFinite(items) || items <= 0) return "empty";
  // Phase 1 cannot distinguish a genuinely fresh cache from a stale one: the
  // external refresh still runs on every launch. Keep the labels descriptive.
  return events.some((event) => event?.name === "cw.external.refresh.start")
    ? "cached-refreshed"
    : "cached-not-refreshed";
}

function summarizeCwGroup(entries) {
  const order = [];
  const stats = new Map();
  const mutationEnd = {
    mutations: [],
    settled: [],
    success: [],
    failed: [],
    lastMutation: [],
    quiet: 0,
    timeout: 0,
  };

  for (const { trace, events } of entries) {
    const root =
      (Array.isArray(trace.marks) ? trace.marks : []).find((mark) => mark?.name === "root.revealed")
        ?.at ?? 0;
    const launch = trace.launchId ?? trace.at;
    const firstByEvent = new Map();

    for (const event of events) {
      const rel = event.at - root;
      let stat = stats.get(event.name);
      if (!stat) {
        stat = { launches: new Set(), count: 0, first: [], last: [] };
        stats.set(event.name, stat);
        order.push(event.name);
      }
      stat.count += 1;
      stat.launches.add(launch);
      const prior = firstByEvent.get(event.name);
      if (prior == null) firstByEvent.set(event.name, { first: rel, last: rel });
      else prior.last = Math.max(prior.last, rel);

      if (event.name === "cw.mutation.end") {
        const detail = event.detail ?? {};
        for (const key of ["mutations", "settled", "success", "failed"]) {
          if (typeof detail[key] === "number") mutationEnd[key].push(detail[key]);
        }
        if (typeof detail.lastMutationAt === "number") {
          mutationEnd.lastMutation.push(detail.lastMutationAt - root);
        }
        if (detail.reason === "quiet") mutationEnd.quiet += 1;
        if (detail.reason === "timeout") mutationEnd.timeout += 1;
      }
    }

    for (const [name, value] of firstByEvent) {
      const stat = stats.get(name);
      stat.first.push(value.first);
      stat.last.push(value.last);
    }
  }

  const rows = order.map((name) => {
    const stat = stats.get(name);
    const first = summary(stat.first);
    const last = summary(stat.last);
    return {
      name,
      launches: stat.launches.size,
      events: stat.count,
      p50First: first?.p50 ?? 0,
      p95First: first?.p95 ?? 0,
      p50Last: last?.p50 ?? 0,
      p95Last: last?.p95 ?? 0,
    };
  });

  return {
    launches: entries.length,
    rows,
    mutationEnd: {
      launches: entries.length,
      mutations: summary(mutationEnd.mutations),
      settled: summary(mutationEnd.settled),
      success: summary(mutationEnd.success),
      failed: summary(mutationEnd.failed),
      lastMutation: summary(mutationEnd.lastMutation),
      quiet: mutationEnd.quiet,
      timeout: mutationEnd.timeout,
    },
  };
}

function summarizeCwTraces(traces) {
  const groups = { "cached-refreshed": [], "cached-not-refreshed": [], empty: [] };
  for (const trace of traces) {
    const events = (Array.isArray(trace.events) ? trace.events : []).filter(
      (event) => typeof event?.name === "string" && event.name.startsWith("cw."),
    );
    if (events.length === 0) continue;
    groups[cwCategory(trace)].push({ trace, events });
  }
  return {
    "cached-refreshed": summarizeCwGroup(groups["cached-refreshed"]),
    "cached-not-refreshed": summarizeCwGroup(groups["cached-not-refreshed"]),
    empty: summarizeCwGroup(groups.empty),
  };
}

export function summarizeStartupTraces(data) {
  const traces = new Map();
  for (const trace of [data?.current, ...(Array.isArray(data?.traces) ? data.traces : [])]) {
    if (!trace || typeof trace !== "object") continue;
    const id =
      typeof trace.launchId === "string" && trace.launchId
        ? `launch:${trace.launchId}`
        : `at:${trace.at}`;
    const previous = traces.get(id);
    if (latestTrace(trace, previous)) traces.set(id, trace);
  }

  const order = [];
  const values = new Map();
  let stalled = 0;
  for (const trace of traces.values()) {
    if (trace.stalled === true) {
      stalled += 1;
      continue;
    }
    for (const measure of Array.isArray(trace.measures) ? trace.measures : []) {
      if (typeof measure?.name !== "string" || typeof measure?.ms !== "number") continue;
      if (!values.has(measure.name)) {
        values.set(measure.name, []);
        order.push(measure.name);
      }
      values.get(measure.name).push(measure.ms);
    }
  }

  return {
    launches: traces.size,
    stalled,
    rows: order.map((name) => {
      const stats = summary(values.get(name));
      return { name, ...stats };
    }),
    cw: summarizeCwTraces([...traces.values()]),
  };
}

const isCli = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/startup-trace-summary.mjs <trace.json>");
    process.exit(2);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Could not read ${file}: ${error.message}`);
    process.exit(1);
  }

  const result = summarizeStartupTraces(data);
  if (result.launches === 0) {
    console.error("No startup traces found.");
    process.exit(1);
  }

  console.log(`launches\t${result.launches}`);
  console.log(`stalled\t${result.stalled}`);
  const longestLongTask = Math.max(
    0,
    ...(Array.isArray(data?.traces) ? data.traces : []).map(
      (trace) => trace?.longTasks?.longestMs ?? 0,
    ),
    data?.current?.longTasks?.longestMs ?? 0,
  );
  const longestPostRevealLongTask = Math.max(
    0,
    ...(Array.isArray(data?.traces) ? data.traces : []).map(
      (trace) => trace?.longTasks?.postRevealLongestMs ?? 0,
    ),
    data?.current?.longTasks?.postRevealLongestMs ?? 0,
  );
  console.log(
    `long-tasks\tlongest=${longestLongTask.toFixed(1)}\tpost-reveal-longest=${longestPostRevealLongTask.toFixed(1)}`,
  );
  if (result.rows.length === 0) {
    console.log("No complete startup measures found.");
  }
  for (const row of result.rows) {
    console.log(
      `${row.name}\tn=${row.n}\tp50=${row.p50.toFixed(1)}\tp95=${row.p95.toFixed(1)}\tmin=${row.min.toFixed(1)}\tmax=${row.max.toFixed(1)}`,
    );
  }

  for (const [category, group] of Object.entries(result.cw)) {
    if (group.launches === 0) continue;
    console.log(`cw-${category}\tlaunches=${group.launches}`);
    for (const row of group.rows) {
      console.log(
        `cw.${category}.${row.name.replace(/^cw\./, "")}\tlaunches=${row.launches}\tevents=${row.events}\tp50-first=${row.p50First.toFixed(1)}\tp95-first=${row.p95First.toFixed(1)}\tp50-last=${row.p50Last.toFixed(1)}\tp95-last=${row.p95Last.toFixed(1)}`,
      );
    }
    const end = group.mutationEnd;
    const fmt = (value) =>
      value == null ? "n/a" : `${value.p50.toFixed(1)}/${value.p95.toFixed(1)}`;
    console.log(
      `cw.${category}.mutation-end\tmutations=${fmt(end.mutations)}\tsettled=${fmt(end.settled)}\tsuccess=${fmt(end.success)}\tfailed=${fmt(end.failed)}\tlast-mutation=${fmt(end.lastMutation)}\tquiet=${end.quiet}\ttimeout=${end.timeout}`,
    );
  }
}
