// Real-browser regression. Run: node tests/form-controls-browser.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/spyder_cctv/assets",
);
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-number-controls-"),
);
const requests = [];
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/form-controls.css"><style>
:root{--accent:#be1a1a;--accent-hover:#830000;--focus:#830000;--ink:#201d1a;--muted:#726d64;--border:#e4dfd4;--surface:#fffefa;--rail:#f0ede4}
*{box-sizing:border-box}body{font:14px Arial;padding:20px;width:360px}.we-help-field{position:relative;margin:16px 0;padding-top:24px}
.we-help-field label{display:grid;gap:4px}.we-help-field input[type=number]{display:block;width:100%;height:38px;margin-top:4px;padding:5px;border:1px solid var(--border)}
.help{position:absolute;right:0;top:0;width:24px;height:24px}.hidden{display:none!important}
</style><main>
<div id="field" class="we-help-field"><button class="help" type="button" aria-label="Field help">?</button><label id="threshold-label">Threshold<input id="threshold" type="number" value="0.2" min="0" max="0.4" step="0.1"></label></div>
<dialog id="settings"><div id="dialog-field" class="we-help-field"><label>Duration<input id="duration" type="number" value="2" min="1" max="4" step="1"></label></div></dialog>
</main><script src="/form-controls.js"></script>`;
const server = http.createServer(async (request, response) => {
  requests.push(request.url);
  const name = new URL(request.url, "http://localhost").pathname;
  if (name === "/" || name === "/index.html") {
    response
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(html);
    return;
  }
  const asset = name.slice(1);
  if (!["form-controls.js", "form-controls.css"].includes(asset)) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, {
      "Content-Type": asset.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/css; charset=utf-8",
    })
    .end(await readFile(path.join(root, asset)));
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
  { windowsHide: true, stdio: ["ignore", "ignore", "inherit"] },
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
  const runtimeErrors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown")
      runtimeErrors.push(message.params.exceptionDetails.text);
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
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const testUrl = `http://127.0.0.1:${server.address().port}/`;
  const { targetId } = await command("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await command("Page.enable", {}, sessionId);
  await command("Runtime.enable", {}, sessionId);
  await command("Page.navigate", { url: testUrl }, sessionId);
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
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(20);
    }
    const state = await evaluate(
      "({url:location.href,ready:document.readyState, html:document.documentElement.outerHTML.slice(0,300),scripts:[...document.scripts].map(s=>s.src),errors:window.errors||[],controls:document.querySelectorAll('.number-stepper').length})",
    );
    throw new Error(
      `Timed out: ${expression}; requests=${JSON.stringify(requests)}; state=${JSON.stringify(state)}; runtime=${JSON.stringify(runtimeErrors)}`,
    );
  }

  await until("document.querySelectorAll('.number-stepper').length === 2");
  assert.deepEqual(
    await evaluate(`(() => {
    const i=document.querySelector('#threshold'), l=document.querySelector('#threshold-label'), c=i.labels[0].nextElementSibling;
    const a=i.getBoundingClientRect(), b=c.getBoundingClientRect(), h=document.querySelector('.help').getBoundingClientRect();
    return {labelled:i.labels[0]===l,controlsOutsideLabel:!l.contains(c),inSameField:c.parentElement.id==='field',
      rightAligned:Math.abs(b.right-a.right)<1,centerAligned:Math.abs((b.top+b.bottom-a.top-a.bottom)/2)<1,
      targetWidth:Math.min(...[...c.children].map(x=>x.getBoundingClientRect().width)),targetHeight:Math.min(...[...c.children].map(x=>x.getBoundingClientRect().height)),
      avoidsHelp:b.top>=h.bottom,helpStillPresent:!!document.querySelector('.help')};
  })()`),
    {
      labelled: true,
      controlsOutsideLabel: true,
      inSameField: true,
      rightAligned: true,
      centerAligned: true,
      targetWidth: 40,
      targetHeight: 40,
      avoidsHelp: true,
      helpStillPresent: true,
    },
  );

  await evaluate(
    "window.fieldEvents=[];const f=document.querySelector('#threshold');f.addEventListener('input',()=>fieldEvents.push('input'));f.addEventListener('change',()=>fieldEvents.push('change'));document.addEventListener('focusin',e=>{if(e.target===f)window.undoFocus=true})",
  );
  const point = await evaluate(
    `(() => {const r=document.querySelector('#threshold').labels[0].nextElementSibling.lastElementChild.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await command(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: point.x, y: point.y },
    sessionId,
  );
  await command(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    },
    sessionId,
  );
  await command(
    "Input.dispatchMouseEvent",
    {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    },
    sessionId,
  );
  await until("document.querySelector('#threshold').value === '0.3'");
  assert.deepEqual(
    await evaluate(
      "({events:fieldEvents,undoFocus,active:document.activeElement.id})",
    ),
    {
      events: ["input", "change"],
      undoFocus: true,
      active: "threshold",
    },
  );
  await evaluate(
    "document.querySelector('#threshold').setAttribute('max','.3')",
  );
  await until(
    "document.querySelector('#threshold').labels[0].nextElementSibling.lastElementChild.disabled",
  );
  await evaluate(
    "document.querySelector('#threshold').setAttribute('max','.4')",
  );
  await until(
    "!document.querySelector('#threshold').labels[0].nextElementSibling.lastElementChild.disabled",
  );
  await evaluate(
    "document.querySelector('#threshold').labels[0].nextElementSibling.lastElementChild.click()",
  );
  await until("document.querySelector('#threshold').value === '0.4'");
  await until(
    "document.querySelector('#threshold').labels[0].nextElementSibling.lastElementChild.disabled",
  );
  const eventCountAtLimit = await evaluate("fieldEvents.length");
  await evaluate(
    "document.querySelector('#threshold').labels[0].nextElementSibling.lastElementChild.click()",
  );
  assert.equal(
    await evaluate("fieldEvents.length"),
    eventCountAtLimit,
    "Bound click emits no events",
  );

  await evaluate("document.querySelector('#field').style.width='280px'");
  await until(
    "Math.abs(document.querySelector('#threshold').getBoundingClientRect().right-document.querySelector('#threshold').labels[0].nextElementSibling.getBoundingClientRect().right)<1",
  );
  await evaluate("document.querySelector('#field').style.width=''");

  await evaluate("document.querySelector('#field').classList.add('hidden')");
  await until(
    "document.querySelector('#threshold').labels[0].nextElementSibling.hidden",
  );
  await evaluate("document.querySelector('#field').classList.remove('hidden')");
  await until(
    "!document.querySelector('#threshold').labels[0].nextElementSibling.hidden",
  );

  await evaluate("document.querySelector('#settings').showModal()");
  await until("document.querySelector('#settings .number-stepper')");
  assert.equal(
    await evaluate(
      "document.querySelector('#settings').contains(document.querySelector('#settings .number-stepper'))",
    ),
    true,
  );
  await evaluate("document.querySelector('#duration').disabled=true");
  await until(
    "[...document.querySelectorAll('#dialog-field .number-stepper button')].every(b=>b.disabled)",
  );
  await evaluate("document.querySelector('#duration').disabled=false");
  await until(
    "[...document.querySelectorAll('#dialog-field .number-stepper button')].every(b=>!b.disabled)",
  );

  await evaluate(
    `(() => {const wrap=document.createElement('div');wrap.id='dynamic-field';wrap.className='we-help-field';wrap.innerHTML='<label>Dynamic<input id="dynamic" type="number" value="1.2" step="any" data-step="0.05"></label>';document.querySelector('main').append(wrap)})()`,
  );
  await until("document.querySelector('#dynamic-field .number-stepper')");
  await evaluate(
    "document.querySelector('#dynamic-field .number-stepper button:last-child').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('#dynamic').value"),
    "1.25",
  );
  assert.equal(
    await evaluate("document.querySelector('#dynamic').step"),
    "any",
  );
  await evaluate(
    "document.querySelector('#dynamic').setAttribute('readonly','')",
  );
  await until(
    "[...document.querySelectorAll('#dynamic-field .number-stepper button')].every(b=>b.disabled)",
  );

  await evaluate(
    `(() => {const wrap=document.createElement('div');wrap.className='we-help-field';wrap.innerHTML='<label>Any step default<input id="any-default" type="number" value="2.3" step="any"></label>';document.querySelector('main').append(wrap)})()`,
  );
  await until(
    "document.querySelector('#any-default')?.labels[0].nextElementSibling",
  );
  await evaluate(
    "document.querySelector('#any-default').labels[0].nextElementSibling.lastElementChild.click()",
  );
  assert.equal(
    await evaluate("document.querySelector('#any-default').value"),
    "3.3",
  );
  assert.equal(
    await evaluate("document.querySelector('#any-default').step"),
    "any",
  );

  await evaluate(
    `(() => {const wrap=document.createElement('div');wrap.className='we-help-field';wrap.innerHTML='<label>Empty<input id="empty" type="number" min="2" max="4" step="1"></label>';document.querySelector('main').append(wrap)})()`,
  );
  await until("document.querySelector('#empty').labels[0].nextElementSibling");
  await evaluate(
    "document.querySelector('#empty').labels[0].nextElementSibling.lastElementChild.click()",
  );
  assert.equal(await evaluate("document.querySelector('#empty').value"), "2");

  await evaluate(
    `(() => {const parent=document.createElement('div');parent.className='we-help-field';parent.innerHTML='<label>First<input id="duplicate" type="number" value="1"></label><label>Second<input id="duplicate" type="number" value="7"></label>';document.querySelector('main').append(parent)})()`,
  );
  await until(
    "document.querySelectorAll('#duplicate').length===2 && document.querySelectorAll('.number-stepper').length===7",
  );
  await evaluate(
    "[...document.querySelectorAll('#duplicate')][1].labels[0].nextElementSibling.lastElementChild.click()",
  );
  assert.equal(
    await evaluate("[...document.querySelectorAll('#duplicate')][1].value"),
    "8",
  );

  await evaluate(
    `(() => {const group=document.createElement('fieldset');group.id='disabled-group';group.disabled=true;group.innerHTML='<label>Group disabled<input id="group-disabled" type="number" value="2"></label>';document.querySelector('main').append(group);window.groupEvents=[];const input=group.querySelector('input');input.addEventListener('input',()=>groupEvents.push('input'));input.addEventListener('change',()=>groupEvents.push('change'))})()`,
  );
  await until("document.querySelector('#disabled-group .number-stepper')");
  assert.deepEqual(
    await evaluate(
      `(() => {const i=document.querySelector('#group-disabled'),buttons=[...i.labels[0].nextElementSibling.children];return {ownDisabled:i.disabled,fieldsetDisabled:i.matches(':disabled'),buttonsDisabled:buttons.every(b=>b.disabled)}})()`,
    ),
    {
      ownDisabled: false,
      fieldsetDisabled: true,
      buttonsDisabled: true,
    },
  );
  await evaluate(
    "document.querySelector('#group-disabled').labels[0].nextElementSibling.lastElementChild.click()",
  );
  assert.equal(
    await evaluate("document.querySelector('#group-disabled').value"),
    "2",
  );
  assert.deepEqual(await evaluate("groupEvents"), []);
  await evaluate("document.querySelector('#disabled-group').disabled=false");
  await until(
    "[...document.querySelectorAll('#disabled-group .number-stepper button')].every(b=>!b.disabled)",
  );
  await evaluate(
    "document.querySelector('#group-disabled').labels[0].nextElementSibling.lastElementChild.click()",
  );
  assert.equal(
    await evaluate("document.querySelector('#group-disabled').value"),
    "3",
  );
  assert.deepEqual(await evaluate("groupEvents"), ["input", "change"]);

  await evaluate(
    `(() => {const normal=document.createElement('div');normal.innerHTML='<input id="ordinary-text" type="text"><input id="ordinary-check" type="checkbox">';document.querySelector('main').append(normal);document.querySelector('#ordinary-text').disabled=true;document.querySelector('#ordinary-check').className='changed';window.ordinaryChanges=true})()`,
  );
  await delay(50);
  assert.deepEqual(
    await evaluate(
      `({text:!!document.querySelector('#ordinary-text'),check:!!document.querySelector('#ordinary-check'),steppers:document.querySelectorAll('.number-stepper').length,changes:ordinaryChanges})`,
    ),
    {
      text: true,
      check: true,
      steppers: 8,
      changes: true,
    },
  );

  await evaluate("document.querySelector('#settings').close()");
  console.log("form-controls browser checks passed");
} finally {
  socket?.close();
  chrome.kill();
  if (chrome.exitCode === null)
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      delay(3000),
    ]);
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 200,
  });
}
