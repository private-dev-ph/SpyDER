// Mobile camera layout regression. Run: node scripts/tests/mobile-camera-layout-browser.mjs <showcase-dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const assets = path.resolve(process.argv[2]);
const headers = await readFile(path.join(assets, "_headers"), "utf8");
const policy = headers
  .split("\n")
  .find((line) => line.trim().startsWith("Content-Security-Policy:"))
  ?.trim()
  .slice("Content-Security-Policy:".length)
  .trim();
assert.ok(policy, "Export needs a content security policy");
const networkPaths = [];
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-mobile-camera-layout-"));
const server = http.createServer(async (req, res) => {
  networkPaths.push(req.url);
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
    res.setHeader("Content-Security-Policy", policy);
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
    url: `http://127.0.0.1:${server.address().port}/#vision-lab`,
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

  async function until(expression) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    const state = await evaluate(
      "({ready:document.readyState,workflow:!!window.spyderWorkflows,app:!!window.spyder,cameras:window.spyder?.cameras?.().length,text:document.body.innerText.slice(0,500)})",
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


  await until("!!window.spyderLayouts && spyder.cameras().length===2");
  const change = (id, value) => evaluate(`(() => {
    const input=document.getElementById(${JSON.stringify(id)});
    input.value=${JSON.stringify(value)};
    input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  const resize = async (width, height=900) => {
    await command('Emulation.setDeviceMetricsOverride', {
      width,height,deviceScaleFactor:1,mobile:width<=800,
    }, sessionId);
    await delay(140);
  };
  const assertStack = async (label) => {
    assert.equal(await evaluate(`(() => {
      const wall=document.querySelector('#cameras');
      const tiles=[...wall.querySelectorAll(':scope > .camera-card:not([hidden])')];
      const boxes=tiles.map(t=>t.getBoundingClientRect());
      return getComputedStyle(wall).gridTemplateColumns.split(' ').length===1 &&
        boxes.every((b,i)=>Math.abs(b.left-boxes[0].left)<1 &&
          (!i || b.top>=boxes[i-1].bottom-1)) &&
        document.documentElement.scrollWidth<=innerWidth;
    })()`),true,label);
  };
  const widths=[320,360,390,412,414,430,440,539,600,768,800];
  await evaluate("location.hash='control-room'");
  await until("!document.querySelector('#control-room').hidden");
  for (const density of ['auto','compact','large']) {
    await change('density',density);
    for (const width of widths) {
      await resize(width);
      await assertStack(`Automatic wall: ${density} at ${width}px stacks feeds`);
    }
  }
  for (const mode of ['grid','auto','featured','sequence']) {
    await resize(1280);
    await evaluate("location.hash='layouts'");
    await until("!!document.querySelector('#layout-mode')");
    await change('layout-mode',mode);
    if (mode==='grid') await change('layout-columns','6');
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Save & apply').click()");
    await evaluate("location.hash='control-room'");
    await until("!document.querySelector('#control-room').hidden");
    for (const width of widths) {
      await resize(width);
      await assertStack(`Saved ${mode} wall at ${width}px stacks feeds`);
      assert.equal(await evaluate("document.querySelector('#cameras').dataset.layoutColumns"),'1');
    }
    for (const width of [801,1280]) {
      await resize(width);
      if (mode!=='sequence') assert.ok(await evaluate("Number(document.querySelector('#cameras').dataset.layoutColumns)>1"),`${mode} desktop columns restored at ${width}px`);
    }
  }
  assert.equal(networkPaths.some(url=>url.startsWith('/api/')),false);
  console.log('PASS: automatic wall at all densities and all saved layout modes stack at 11 mobile widths; desktop columns return above 800px.');
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
