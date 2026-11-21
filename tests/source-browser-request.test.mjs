import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src-tauri/src/cf_solver.rs", import.meta.url), "utf8");
const template = source.match(/let script = format!\(\s*r#"([\s\S]*?)"#,/)[1];

test("verification distinguishes a completed login page from a usable source page", () => {
  const script = source.match(/const PROBE_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1];
  for (const status of [200, 401]) {
    const probe = vm.runInNewContext(script, {
      location: { hostname: "source.example", protocol: "https:" },
      navigator: { userAgent: "fixture-browser" },
      performance: { getEntriesByType: () => [{ responseStatus: status }] },
      document: {
        title: "Source",
        readyState: "complete",
        body: { innerText: "Members only. Sign in." },
        documentElement: { outerHTML: "<html>" + "content".repeat(50) + "</html>" },
        querySelector: () => null,
      },
    });
    assert.equal(probe.authentication_required, status === 401);
    assert.equal(probe.challenged, false);
  }
});

async function browserRequest(request, allowNavigation, fetchResponse) {
  const address = "https://source.example/api";
  const values = ["fixture", address, 2 * 1024 * 1024, request, allowNavigation];
  let index = 0;
  const script = template.replace(/\{\{|\}\}|\{\}/g, (token) =>
    token === "{{" ? "{" : token === "}}" ? "}" : JSON.stringify(values[index++]),
  );
  assert.equal(index, values.length);
  const calls = [];
  const window = {};
  const context = {
    window,
    location: { origin: "https://source.example", href: address },
    document: {
      title: "Source home",
      readyState: "complete",
      documentElement: { outerHTML: `<html>${"unrelated homepage".repeat(30)}</html>` },
      querySelector: () => null,
    },
    URL,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    performance: { getEntriesByType: () => [{ responseStatus: 200 }] },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchResponse instanceof Error) throw fetchResponse;
      return fetchResponse;
    },
  };
  vm.runInNewContext(script, context);
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
    const result = window.__harborCfBrowserResults?.fixture;
    if (result) return { result, calls };
  }
  throw new Error("Browser request did not settle");
}

test("browser API fetch preserves POST data and uses only same-origin browser credentials", async () => {
  const body = JSON.stringify({ title: "a'b\"c", chapter: 42 });
  const { result, calls } = await browserRequest(
    {
      method: "POST",
      body,
      headers: { "content-type": "application/json", accept: "application/json" },
      referrer: "https://source.example/reader",
    },
    false,
    new Response('{"images":["page"]}', { headers: { "content-type": "application/json" } }),
  );
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, body);
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.equal(calls[0].options.referrer, "https://source.example/reader");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(result.body, '{"images":["page"]}');
});

test("navigation recovery accepts real content but rejects HTTP authorization errors", () => {
  const navigationTemplate = source.match(/let read = format!\(\s*r#"([\s\S]*?)"#,/)[1];
  const address = "https://source.example/details";
  const values = [address, 2 * 1024 * 1024];
  let index = 0;
  const script = navigationTemplate.replace(/\{\{|\}\}|\{\}/g, (token) =>
    token === "{{" ? "{" : token === "}}" ? "}" : JSON.stringify(values[index++]),
  );
  for (const status of [200, 401, 403]) {
    const result = vm.runInNewContext(script, {
      location: { href: address },
      performance: { getEntriesByType: () => [{ responseStatus: status }] },
      document: {
        title: "Details",
        readyState: "complete",
        body: { innerText: "Details" },
        documentElement: { outerHTML: `<html>${"details".repeat(50)}</html>` },
        querySelector: () => null,
      },
    });
    if (status === 200) assert.equal(result.status, 200);
    else assert.equal(result.state, "error");
  }
});

test("failed POST and JSON GET cannot return the currently loaded HTML document", async () => {
  for (const method of ["GET", "POST"]) {
    const { result } = await browserRequest(
      { method, headers: { accept: "application/json" } },
      false,
      new Error("blocked"),
    );
    assert.equal(result.state, "error");
    assert.equal(result.body, undefined);
  }
});

test("browser API errors retain the server's status and response body", async () => {
  const { result } = await browserRequest(
    { method: "POST", headers: {} },
    false,
    new Response('{"error":"missing chapter"}', {
      status: 404,
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(result.state, "ready");
  assert.equal(result.status, 404);
  assert.equal(result.body, '{"error":"missing chapter"}');
});
