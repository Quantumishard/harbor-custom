import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { addAbortListener, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Cdp } from "../scripts/harbor-diag.mjs";

const chromium = process.env.HARBOR_SCROLLBAR_CHROME;
const appCss = new URL("../src/index.css", import.meta.url);
const disclosureCss = new URL("../src/components/music/music-artist-overview.css", import.meta.url);
const pageZoom = 1.6;
const title = "Harbor scrollbar regression";

// Opt in with HARBOR_SCROLLBAR_CHROME pointing at a Windows Chromium executable.
// CDP exercises CSS and scroll input in an isolated page. Read the actual Windows cursor separately.
test(
  "the Harbor anchor keeps native disclosure and Settings scrollbar behavior",
  {
    skip: process.platform !== "win32" || !chromium,
    timeout: 20_000,
  },
  async (context) => {
    const { signal } = context;
    const profile = await mkdtemp(join(tmpdir(), "harbor-scrollbar-"));
    let browser;
    let exited;
    let socket;
    let abortListener;
    const server = createServer();
    try {
      const styles = new Map([
        ["/app.css", await readFile(appCss, "utf8")],
        ["/harbor-cursor.css", await readFile(new URL("harbor-cursor.css", appCss), "utf8")],
        ["/disclosure.css", await readFile(disclosureCss, "utf8")],
      ]);
      const cursor = await readFile(new URL("assets/harbor-cursor.png", appCss));
      server.on("request", (req, res) => {
        if (styles.has(req.url)) {
          res.setHeader("Content-Type", "text/css");
          res.end(styles.get(req.url));
        } else if (req.url === "/anchor.png") {
          res.setHeader("Content-Type", "image/png");
          res.end(cursor);
        } else if (req.url === "/") {
          res.setHeader("Content-Type", "text/html");
          res.end(`<!doctype html><html data-os="windows" style="--harbor-cursor-image:url('/anchor.png') 9 1">
          <title>${title}</title>
          <link rel="stylesheet" href="/app.css">
          <link rel="stylesheet" href="/disclosure.css">
          <style>
            @layer utilities {
              .cursor-grab {cursor: grab}
              .cursor-pointer {cursor: var(--harbor-cursor-pointer, pointer)}
            }
            body {margin: 0; --color-edge: #889099}
            .fixture {margin: 70px; width: 210px; height: 230px; display: flex; flex-direction: column}
            .spacer {flex: none; height: 900px}
            .explicit-default {cursor: default}
            .explicit-none {cursor: none}
          </style>
          <div class="fixture">
            <div class="hset-rail-nav"><div class="spacer"></div></div>
          </div>
          <details class="music-buy-links"><summary id="late">Late CSS</summary>Contents</details>
          <details><summary id="plain">Plain</summary>Contents</details>
          <details><summary id="utility" class="cursor-grab"><span id="grabChild">Drag</span></summary></details>
          <details><summary id="inline" style="cursor: wait">Wait</summary></details>
          <details><summary id="pointerUtility" class="cursor-pointer">Pointer utility</summary></details>
          <button id="button">Enabled</button>
          <button id="disabled" class="explicit-default" disabled>Disabled</button>
          <a id="link" href="#plain">Link</a>
          <span id="roleButton" role="button">Role button</span>
          <span id="roleDisabled" role="button" aria-disabled="true" class="explicit-default">Unavailable</span>
          <input id="input" value="Text">
          <div class="explicit-none"><span id="hidden">Hidden</span></div>`);
        } else {
          res.writeHead(404).end();
        }
      });
      const listening = once(server, "listening", { signal });
      server.listen(0, "127.0.0.1");
      await listening;
      const url = `http://127.0.0.1:${server.address().port}/`;
      const profileDir = join(profile, "Default");
      await mkdir(profileDir);
      // Chromium browser zoom, matching WebView2's zoom rather than CSS zoom.
      await writeFile(
        join(profileDir, "Preferences"),
        JSON.stringify({
          partition: { default_zoom_level: { x: Math.log(pageZoom) / Math.log(1.2) } },
        }),
      );
      browser = spawn(
        chromium,
        [
          "--headless=new",
          "--disable-gpu",
          "--disable-background-networking",
          "--no-first-run",
          "--no-default-browser-check",
          "--remote-debugging-port=0",
          "--force-device-scale-factor=1",
          "--window-size=1000,800",
          `--user-data-dir=${profile}`,
          url,
        ],
        { signal, stdio: "ignore", windowsHide: true },
      );
      exited = new Promise((resolve) => browser.once("close", resolve));
      const launched = once(browser, "spawn", { signal });
      // Aborting the spawned child emits an error before it closes.
      browser.on("error", () => {});
      await launched;
      const endpointFile = join(profile, "DevToolsActivePort");
      let target;
      for (let attempt = 0; !target && attempt < 60; attempt++) {
        await delay(100, undefined, { signal });
        const endpoint = await readFile(endpointFile, "utf8").catch(() => "");
        if (!endpoint) continue;
        const targets = await fetch(`http://127.0.0.1:${endpoint.split("\n")[0]}/json/list`, {
          signal,
        })
          .then((res) => res.json())
          .catch(() => []);
        target = targets.find(
          (page) => page.type === "page" && page.url === url && page.title === title,
        );
      }
      assert.ok(target, "Chromium did not open the test fixture");
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await once(socket, "open", { signal });
      const cdp = new Cdp(socket, target);
      socket.addEventListener("message", (event) => cdp.onMessage(String(event.data)));
      const aborted = new Promise((_, reject) => {
        abortListener = addAbortListener(signal, () => reject(signal.reason));
      });
      const withinTimeout = (operation) => Promise.race([operation, aborted]);
      const send = (method, params) => withinTimeout(cdp.send(method, params));
      const evaluate = async (expression) => {
        const reply = await send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        assert.equal(
          reply.exceptionDetails,
          undefined,
          reply.exceptionDetails?.exception?.description,
        );
        return reply.result.value;
      };
      await evaluate(
        "new Promise(resolve => document.readyState === 'complete' ? resolve() : window.addEventListener('load', resolve, { once: true }))",
      );
      await context.test("native summaries inherit the anchor past late module CSS", async () => {
        const cursors = () =>
          evaluate(`Object.fromEntries([...document.querySelectorAll('[id]')].map(
            element => [element.id, getComputedStyle(element).cursor]
          ).concat([['body', getComputedStyle(document.body).cursor]]))`);
        const off = await cursors();
        assert.equal(off.late, "pointer");
        assert.equal(off.button, "pointer");
        assert.equal(off.body, "default");
        await evaluate('document.documentElement.setAttribute("data-harbor-cursor", "")');
        const on = await cursors();
        for (const id of ["late", "plain", "pointerUtility", "button", "link", "roleButton"]) {
          assert.match(on[id], /anchor\.png.*9 1, pointer$/, id);
        }
        assert.match(on.body, /anchor\.png.*9 1, default$/);
        assert.equal(on.utility, "grab");
        assert.equal(on.grabChild, "grab");
        assert.equal(on.inline, "wait");
        assert.equal(on.disabled, "default");
        assert.equal(on.roleDisabled, "default");
        assert.equal(on.input, "text");
        assert.equal(on.hidden, "none");
        await evaluate('document.getElementById("late").focus()');
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          text: "\r",
          windowsVirtualKeyCode: 13,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        assert.equal(await evaluate('document.getElementById("late").parentElement.open'), true);
        await evaluate('document.documentElement.removeAttribute("data-harbor-cursor")');
        assert.deepEqual(await cursors(), off);
      });
      const measure = () =>
        evaluate(`(() => {
      const rail = document.querySelector(".hset-rail-nav");
      const rect = rail.getBoundingClientRect();
      const content = rail.firstElementChild.getBoundingClientRect();
      const gutter = rect.width - content.width;
      return {
        dpr: devicePixelRatio,
        width: gutter * devicePixelRatio,
        standardWidth: getComputedStyle(rail).scrollbarWidth,
        x: content.left - rect.left > .1
          ? (rect.left + content.left) / 2
          : (content.right + rect.right) / 2,
        thumbY: rect.top + rect.height / 8,
        arrowY: rect.bottom - gutter / 2,
        pageHeight: rail.clientHeight,
        lane: content.left - rect.left > .1 ? "left" : "right",
      };
    })()`);
      const reset = () => evaluate('document.querySelector(".hset-rail-nav").scrollTop = 0');
      const scrollOffset = () =>
        evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve(document.querySelector(".hset-rail-nav").scrollTop);
        })))`);
      for (const direction of ["ltr", "rtl"]) {
        await evaluate(`document.documentElement.dir = "${direction}";
        document.documentElement.removeAttribute("data-harbor-cursor")`);
        const native = await measure();
        assert.ok(Math.abs(native.dpr - pageZoom) < 0.01, "fixture uses browser zoom 160%");
        assert.equal(native.standardWidth, "thin");
        assert.equal(native.lane, direction === "ltr" ? "right" : "left");
        assert.ok(native.width > 0);
        for (const mode of ["off", "on", "forced colors"]) {
          const description = `${direction}, ${mode}`;
          const forcedColors = mode === "forced colors";
          await evaluate(
            `document.documentElement.toggleAttribute("data-harbor-cursor", ${mode !== "off"})`,
          );
          await send("Emulation.setEmulatedMedia", {
            features: forcedColors ? [{ name: "forced-colors", value: "active" }] : [],
          });
          assert.equal(
            await evaluate('matchMedia("(forced-colors: active)").matches'),
            forcedColors,
          );
          await reset();
          assert.deepEqual(await measure(), native, `${description}: scrollbar geometry`);
          const { x, thumbY, arrowY, pageHeight } = native;
          const move = (y, buttons) =>
            send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
              buttons,
              button: buttons ? "left" : "none",
            });
          const press = (y) =>
            send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              buttons: 1,
              clickCount: 1,
            });
          const release = (y) =>
            send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 1,
            });

          await scrollOffset();
          await move(thumbY, 0);
          await press(thumbY);
          await move(thumbY + 45, 1);
          await release(thumbY + 45);
          assert.ok((await scrollOffset()) > 0, `${description}: scrollbar thumb did not scroll`);

          await reset();
          await scrollOffset();
          // The native decrement/increment buttons occupy the ends of the lane.
          await move(arrowY, 0);
          await press(arrowY);
          await release(arrowY);
          await delay(250, undefined, { signal });
          const step = await scrollOffset();
          assert.ok(
            step > 0 && step < pageHeight / 2,
            `${description}: expected one scrollbar arrow step, got ${step}`,
          );
        }
        await send("Emulation.setEmulatedMedia", { features: [] });
      }
      await withinTimeout(Promise.race([cdp.send("Browser.close"), exited]));
      await withinTimeout(exited);
    } finally {
      abortListener?.[Symbol.dispose]();
      socket?.close();
      if (browser?.exitCode === null && browser.signalCode === null) browser.kill();
      await exited;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
