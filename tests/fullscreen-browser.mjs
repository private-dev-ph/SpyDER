// Real mouse hit-testing regression. Run: node tests/fullscreen-browser.mjs <showcase-dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const assets = path.resolve(process.argv[2]);
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-ribbon-browser-"));
const server = http.createServer(async (req, res) => {
  const name =
    new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[\w.-]+$/.test(name)) return res.writeHead(404).end();
  try {
    const body = await readFile(path.join(assets, name));
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    res.setHeader(
      "Content-Type",
      mime[path.extname(name)] || "application/octet-stream",
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
  for (let i = 0; i < 100; i++) {
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
        reject(new Error(`Timed out: ${method}`));
      }, 10000);
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
  for (let i = 0; i < 100; i++) {
    if (await evaluate("!!window.spyderWall")) break;
    await delay(100);
  }
  await evaluate("window.spyderWall.enter()");
  await delay(200);
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
    );
    for (const name of ["nav", "tools"]) {
      for (const fraction of [0.2, 0.5, 0.8]) {
        const bounds = await evaluate(
          `(() => { const r=document.querySelector('#wall-${name}-tab').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*${fraction},top:r.top};})()`,
        );
        await command(
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", x: bounds.x, y: bounds.y },
          sessionId,
        );
        await command(
          "Input.dispatchMouseEvent",
          {
            type: "mousePressed",
            x: bounds.x,
            y: bounds.y,
            button: "left",
            clickCount: 1,
          },
          sessionId,
        );
        await delay(80);
        const pressedTop = await evaluate(
          `document.querySelector('#wall-${name}-tab').getBoundingClientRect().top`,
        );
        const diagnostic = await evaluate(
          `(() => {const b=document.querySelector('#wall-${name}-tab');return {active:b.matches(':active'),transform:getComputedStyle(b).transform,hit:document.elementFromPoint(${bounds.x},${bounds.y})?.id};})()`,
        );
        await command(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: bounds.x,
            y: bounds.y,
            button: "left",
            clickCount: 1,
          },
          sessionId,
        );
        assert.equal(
          await evaluate(
            `!document.querySelector('#wall-${name}-panel').hidden`,
          ),
          true,
          `${theme} ${name} ${fraction}: click did not open drawer (pressed movement ${pressedTop - bounds.top}px, ${JSON.stringify(diagnostic)})`,
        );
        await evaluate(
          `document.querySelector('#wall-${name}-panel [data-close]').click()`,
        );
      }
    }
    const color = await evaluate(
      "getComputedStyle(document.documentElement).scrollbarColor.split(')')[0]+')'",
    );
    assert.equal(
      color,
      "rgb(190, 26, 26)",
      `${theme} scrollbar thumb must use theme red`,
    );
  }
  console.log(
    "PASS: both ribbons open across upper/middle/lower hit areas in light/dark mode; red scrollbars.",
  );
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(200);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
