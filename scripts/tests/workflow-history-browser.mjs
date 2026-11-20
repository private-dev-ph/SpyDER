// Populated native-history UI with an isolated HTTP fixture; never touches user data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-workflow-history-browser-"),
);
const networkPaths = [];
let runs = Array.from({ length: 26 }, (_, i) => ({
  id: "run-" + i,
  name: "Test workflow " + i,
  workflow_id: "wf-1",
  camera_id: "cam-1",
  state: i % 3 === 0 ? "error" : i % 3 === 1 ? "filtered" : "completed",
  duration_ms: i + 1,
  source: "live",
  started_at: "2026-10-26T01:00:00+00:00",
}));
const server = http.createServer(async (req, res) => {
  networkPaths.push(req.url);
  res.setHeader("Content-Type", "application/json");
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/workflows/history") {
    const page = Math.max(
      0,
      Math.min(
        Number(url.searchParams.get("page") || 0),
        Math.ceil(runs.length / 25) - 1,
      ),
    );
    return res.end(
      JSON.stringify({
        runs: runs.slice(page * 25, page * 25 + 25),
        total: runs.length,
        page,
        pages: Math.ceil(runs.length / 25),
        settings: { enabled: true, mode: "diagnostic", retention_days: 7 },
        stats: { data_bytes: 200, database_bytes: 1000 },
        overview: {
          completed: 8,
          filtered: 9,
          error: 9,
          average_duration_ms: 13.5,
        },
      }),
    );
  }
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    if (url.pathname.endsWith("/delete")) {
      const before = runs.length;
      runs = runs.filter((run) => !data.ids.includes(run.id));
      return res.end(JSON.stringify({ deleted: before - runs.length }));
    }
    if (url.pathname.endsWith("/export"))
      return res.end(
        JSON.stringify({
          format: "spyder-workflow-history",
          version: 1,
          runs: runs.filter((run) => data.ids.includes(run.id)),
        }),
      );
  }
  if (url.pathname.startsWith("/api/workflows/history/run-"))
    return res.end(
      JSON.stringify({
        ...runs[0],
        context: { cv: { detections: [] } },
        graph: {
          nodes: [{ id: "filter", type: "filter", params: { class: "face" } }],
          edges: [],
        },
        nodes: [
          {
            id: "filter",
            type: "filter",
            state: "filtered",
            input_count: 1,
            output_count: 0,
            duration_ms: 2,
            path: ["parent", "filter"],
            inputs: [{ identity: "Unknown" }],
            outputs: [],
          },
        ],
        actions: [],
      }),
    );
  const name = url.pathname.slice(1);
  try {
    if (!name) {
      res.setHeader("Content-Type", "text/html");
      return res.end(
        '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="dashboard.css"><link rel="stylesheet" href="workflow-tools.css"><button id="open">Open history</button><script src="workflow-run-view.js"></script><script src="workflow-tools.js"></script><script>window.errors=[];window.addEventListener("error",e=>errors.push(e.message));document.querySelector("#open").onclick=()=>spyderWorkflowTools.openHistory();window.confirm=()=>true;</script>',
      );
    }
    if (!/^[a-z.-]+$/.test(name)) throw Error("invalid");
    const body = await readFile(
      new URL("../../src/spyder_cctv/assets/" + name, import.meta.url),
    );
    res.setHeader(
      "Content-Type",
      name.endsWith(".css")
        ? "text/css"
        : name.endsWith(".svg")
          ? "image/svg+xml"
          : "text/javascript",
    );
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const chrome = spawn(
  process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-background-networking",
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let socket;
try {
  let port;
  for (let i = 0; i < 300; i++) {
    try {
      port = (
        await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(port, "Chrome debugging endpoint did not start");
  const info = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const result = pending.get(message.id);
    if (!result) return;
    pending.delete(message.id);
    clearTimeout(result.timer);
    if (message.error) result.reject(new Error(JSON.stringify(message.error)));
    else result.resolve(message.result);
  };
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `Timed out: ${method} ${(params.expression || "").slice(0, 180)}`,
          ),
        );
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const { targetId } = await command("Target.createTarget", {
    url: `http://127.0.0.1:${server.address().port}/#control-room`,
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  async function evaluate(expression) {
    const result = await command(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  async function until(expression, attempts = 100) {
    for (let i = 0; i < attempts; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    const state = await evaluate(
      "({ready:document.readyState,workflow:!!window.spyderWorkflows,app:!!window.spyder,cameras:window.spyder?.cameras?.().length,issues:document.querySelector('.we-issues')?.textContent,text:document.body.innerText.slice(0,500)})",
    );
    throw new Error(
      "Timed out: " +
        expression +
        "; state=" +
        JSON.stringify(state) +
        "; requests=" +
        JSON.stringify(networkPaths),
    );
  }

  await command("Page.enable", {}, sessionId);
  await command(
    "Page.navigate",
    { url: `http://127.0.0.1:${server.address().port}/` },
    sessionId,
  );
  await until("!!window.spyderWorkflowTools", 300);
  await evaluate("document.querySelector('#open').click()");
  await until("document.querySelectorAll('[data-hist-select]').length===25");
  assert.match(
    await evaluate(
      "document.querySelector('[data-hist-overview]').textContent",
    ),
    /13.5 ms/,
  );
  await evaluate("document.querySelector('[data-hist-select-page]').click()");
  assert.match(
    await evaluate(
      "document.querySelector('[data-hist-selected]').textContent",
    ),
    /25 selected/,
  );
  await evaluate(
    "document.querySelector('[data-hist-export-selected]').click()",
  );
  await until(
    "document.querySelector('[data-hist-live-status]').textContent.includes('Export ready')",
  );
  await evaluate(
    "document.querySelector('[data-hist-delete-selected]').click()",
  );
  await until("document.querySelectorAll('[data-hist-select]').length===1");
  assert.match(
    await evaluate(
      "document.querySelector('[data-hist-selected]').textContent",
    ),
    /0 selected/,
  );
  await evaluate("document.querySelector('[data-hist-open]').click()");
  await until("!!document.querySelector('[data-inspect-node]')");
  await evaluate(
    "document.querySelector('.wt-trace').open=true;document.querySelector('[data-inspect-node]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
  );
  assert.match(
    await evaluate(
      "document.querySelector('[data-hist-node-inspector]').textContent",
    ),
    /Unknown/,
  );
  for (const [width, height] of [
    [320, 640],
    [390, 700],
    [1280, 480],
  ]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.wt-history').scrollWidth<=document.querySelector('.wt-history').clientWidth+1",
      ),
      true,
      "history horizontal overflow",
    );
  }
  await evaluate(
    "document.querySelector('[data-hist-close-detail]').click();document.querySelector('[data-hist-live]').click()",
  );
  const count = networkPaths.filter((p) =>
    p.startsWith("/api/workflows/history?"),
  ).length;
  await delay(5500);
  assert.ok(
    networkPaths.filter((p) => p.startsWith("/api/workflows/history?")).length >
      count,
    "live refresh",
  );
  await evaluate(
    "spyderWorkflowTools.closeAll();window.spyderShowcase=true;spyderWorkflowTools.openHistory()",
  );
  const demoCount = networkPaths.length;
  await until(
    "document.querySelector('[data-hist-runs]').textContent.includes('showcase')",
  );
  assert.equal(networkPaths.length, demoCount, "showcase no API");
  assert.deepEqual(await evaluate("errors"), []);
  console.log(
    "PASS: populated history metrics, selection/export/delete, keyboard node inspector, mobile/short layout, live refresh, showcase isolation",
  );
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(200);
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
  assert.ok(
    path.basename(profile).startsWith("spyder-workflow-history-browser-"),
  );
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
