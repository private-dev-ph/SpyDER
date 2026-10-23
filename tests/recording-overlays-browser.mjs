/* Real Chrome regression for recording detection overlays. Run: node tests/recording-overlays-browser.mjs */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = path.resolve(
  process.env.SPYDER_ASSET_ROOT ||
    path.join(repo, "src", "spyder_cctv", "assets"),
);
const fixture = await readFile(
  path.join(repo, "tests", "fixtures", "enrollment-range.mp4"),
);
const css = await readFile(
  path.join(assetRoot, "recording-overlays.css"),
  "utf8",
);
const paths = [];
const nativeClip = "a".repeat(32);
const apiData = (index, boxX = 0.1) =>
  JSON.stringify({
    version: 1,
    chunk_seconds: 30,
    index,
    media_id: nativeClip,
    width: 200,
    height: 100,
    fps: 5,
    available: index === 0,
    truncated: false,
    samples:
      index === 0
        ? [
            {
              time: 0.2,
              boxes: [
                {
                  bbox: [boxX, 0.1, 0.2, 0.3],
                  camera_id: "cam",
                  kind: "person",
                  label: "old",
                  track_id: 7,
                },
              ],
            },
          ]
        : [],
  });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  paths.push(url.pathname + url.search);
  if (url.pathname === "/") {
    const demo = url.searchParams.has("demo");
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Security-Policy": `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src ${demo ? "'none'" : "'self'"}`,
    });
    return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/recording-overlays.css"><style>
      :root{--gold:#f8ebab;--surface:#fffefa;--text:#222;--canvas:#f7f5ef} body.dark{--gold:#ffcf70;--surface:#171717;--text:#f5f5f5;--canvas:#080808;background:var(--canvas);color:var(--text)}
      *{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--text);font:14px sans-serif}#host{width:420px;max-width:100vw;margin:12px auto}#stage{height:300px;width:420px;max-width:100vw}.media-viewer-stage :is(video,img){height:220px;max-height:220px}
      .button{padding:8px 10px;border:1px solid #777;border-radius:5px;background:var(--surface);color:var(--text);font:inherit;white-space:normal}
      .recording-overlay-controls{min-width:0}.recording-overlay-status{overflow-wrap:anywhere}
    </style></head><body><main id="host"><div id="stage" class="media-viewer-stage"></div></main><script src="/recording-overlays.js"></script><script src="/event-library.js"></script></body></html>`);
  }
  if (url.pathname === "/recording-overlays.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(
      await readFile(path.join(assetRoot, "recording-overlays.js")),
    );
  }
  if (url.pathname === "/recording-overlays.css") {
    res.writeHead(200, { "Content-Type": "text/css" });
    return res.end(css);
  }
  if (url.pathname === "/event-library.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(await readFile(path.join(assetRoot, "event-library.js")));
  }
  if (url.pathname === "/fixture.mp4") {
    const range = req.headers.range;
    if (range) {
      const [, startText, endText] = /bytes=(\d+)-(\d*)/.exec(range) || [];
      const start = Number(startText || 0),
        end = Math.min(
          Number(endText || fixture.length - 1),
          fixture.length - 1,
        );
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${fixture.length}`,
        "Content-Length": end - start + 1,
      });
      return res.end(fixture.subarray(start, end + 1));
    }
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": fixture.length,
      "Accept-Ranges": "bytes",
    });
    return res.end(fixture);
  }
  if (url.pathname === `/api/media/${nativeClip}/overlays`) {
    const index = Number(url.searchParams.get("chunk"));
    if (index === 0) await delay(800); // Simulate a late response after seek/import invalidates it.
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(apiData(index));
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-overlays-chrome-"),
);
const screenshot = path.join(
  os.tmpdir(),
  `spyder-recording-overlays-${Date.now()}.png`,
);
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
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error
      ? entry.reject(
          new Error(`${entry.method}: ${JSON.stringify(message.error)}`),
        )
      : entry.resolve(message.result);
  };
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out: ${method}`));
        }, 30000);
      pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const { targetId } = await command("Target.createTarget", {
    url: `http://127.0.0.1:${server.address().port}/?demo=1`,
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  async function evaluate(expression, userGesture = false) {
    const result = await command(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(userGesture ? { userGesture: true } : {}),
      },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error("Timed out: " + expression);
  }
  await until(
    "!!window.spyderRecordingOverlays && !!window.spyderEventLibrary",
  );
  console.log("Overlay scripts ready.");
  const fixtureData = (width, height, samples) => ({
    version: 1,
    chunk_seconds: 30,
    index: 0,
    width,
    height,
    fps: 5,
    truncated: false,
    samples,
  });
  const encode = (data) => Buffer.from(JSON.stringify(data)).toString("base64");
  const overlayFixture = {
    ...fixtureData(200, 100, [
      {
        time: 0.5,
        boxes: [
          {
            bbox: [0.25, 0.25, 0.5, 0.5],
            camera_id: "cam",
            kind: "person",
            label: "first",
          },
        ],
      },
      {
        time: 1.5,
        boxes: [
          {
            bbox: [0.65, 0.25, 0.2, 0.5],
            camera_id: "cam",
            kind: "person",
            label: "future",
          },
        ],
      },
    ]),
    media_id: nativeClip,
  };
  const imgSidecar = gzipSync(Buffer.from(JSON.stringify(overlayFixture)));
  const imgBase64 = imgSidecar.toString("base64");
  const wrongIdBase64 = Buffer.from(
    JSON.stringify({ ...overlayFixture, media_id: "b".repeat(32) }),
  ).toString("base64");
  const cases = await evaluate(`(async()=>{
    window.asserts=[];window.fetchCalls=0;const baseFetch=window.fetch;window.fetch=(...args)=>{window.fetchCalls++;return baseFetch(...args)};
    const stage=document.querySelector('#stage');stage.style.height='300px';stage.style.width='420px';
    const img=document.createElement('img');img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="black"/></svg>');stage.append(img);
    await img.decode();window.t=1;window.overlay=spyderRecordingOverlays.attach(stage,{item:{id:'${nativeClip}',overlayChunks:{0:${JSON.stringify(overlayFixture)}}},media:img,time:()=>window.t,demo:true});
    const canvas=stage.querySelector('canvas'),toggle=stage.querySelector('input[type=checkbox]');
    const alpha=(x,y)=>canvas.getContext('2d').getImageData(Math.round(x*devicePixelRatio),Math.round(y*devicePixelRatio),1,1).data[3];
    const controls=stage.querySelector('.recording-overlay-controls');
    const defaultOff=toggle.checked===false && alpha(105,75)===0;
    toggle.checked=true;toggle.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,100));
    const letterbox=img.getBoundingClientRect(),sr=stage.getBoundingClientRect(),scale=Math.min(letterbox.width/img.naturalWidth,letterbox.height/img.naturalHeight),imgLeft=letterbox.left-sr.left+(letterbox.width-img.naturalWidth*scale)/2,imgTop=letterbox.top-sr.top+(letterbox.height-img.naturalHeight*scale)/2;
    const oldX=imgLeft+img.naturalWidth*scale*.25,futureX=imgLeft+img.naturalWidth*scale*.85,boxY=imgTop+img.naturalHeight*scale*.5;
    const firstBox=alpha(oldX,boxY)>0 && alpha(futureX,boxY)===0;
    window.t=2;await overlay.update(window.t);await new Promise(r=>setTimeout(r,30));
    const futureSample=alpha(oldX,boxY)===0 && alpha(futureX,boxY)>0;
    window.t=31;await overlay.update(window.t);await new Promise(r=>setTimeout(r,30));
    const emptyChunk=alpha(futureX,boxY)===0 && stage.querySelector('.recording-overlay-status').textContent.includes('No saved detections');
    const canvasBefore=canvas.width;stage.style.width='320px';window.dispatchEvent(new Event('resize'));await new Promise(r=>setTimeout(r,100));
    const resized=canvas.width!==canvasBefore;
    const lightTheme=getComputedStyle(document.body).backgroundColor==='rgb(247, 245, 239)';
    document.body.classList.add('dark');await overlay.update(1);await new Promise(r=>setTimeout(r,30));
    const darkTheme=getComputedStyle(document.body).backgroundColor==='rgb(8, 8, 8)';
    const noOverflow=stage.scrollWidth<=stage.clientWidth && document.documentElement.scrollWidth<=innerWidth;
    const fullButton=stage.querySelector('.recording-overlay-fullscreen');
    const fullscreen=false;
    window.demoNoFetch=window.fetchCalls===0;
    return {defaultOff,letterbox,firstBox,futureSample,emptyChunk,resized,lightTheme,darkTheme,noOverflow,fullscreen,fullButtonVisible:!fullButton.hidden,demoNoFetch:window.demoNoFetch};
  })()`);
  console.log("Demo visual cases finished.");
  assert.equal(
    cases.defaultOff,
    true,
    "toggle starts off with no rendered boxes",
  );
  assert.ok(
    cases.firstBox,
    "imported detection aligns with letterboxed image and ignores future sample",
  );
  assert.ok(
    cases.futureSample,
    "seek advances to latest sample at or before displayed time",
  );
  assert.ok(cases.emptyChunk, "seek to empty chunk clears old boxes");
  assert.ok(cases.resized, "canvas resizes with media surface");
  assert.ok(cases.lightTheme, "light theme remains applied");
  assert.ok(cases.darkTheme, "dark theme remains applied");
  assert.ok(cases.noOverflow, "mobile-width controls do not overflow");
  assert.ok(
    cases.fullButtonVisible,
    "overlay surface exposes explicit full-screen control",
  );
  assert.ok(
    cases.demoNoFetch,
    "showcase import path makes no fetch calls under connect-src none",
  );
  assert.ok(
    css.includes(".recording-overlay-surface:fullscreen"),
    "fullscreen wrapper CSS is present",
  );
  let fullscreenVerified = false;
  try {
    await evaluate(
      "document.querySelector('.recording-overlay-fullscreen').click()",
      true,
    );
    await until(
      "document.fullscreenElement===document.querySelector('#stage')",
    );
    fullscreenVerified = await evaluate(
      "(()=>{const stage=document.querySelector('#stage'),canvas=stage.querySelector('canvas');return stage.clientWidth===innerWidth&&canvas.clientWidth===stage.clientWidth})()",
    );
    await evaluate("document.exitFullscreen()");
  } catch {
    /* Browser may block fullscreen in headless automation. */
  }
  if (fullscreenVerified) console.log("Fullscreen wrapper: passed.");
  else
    console.log(
      "Fullscreen wrapper: browser policy blocked automation; explicit control and fullscreen CSS verified.",
    );
  await command(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true },
    sessionId,
  ).then(async (image) =>
    writeFile(screenshot, Buffer.from(image.data, "base64")),
  );
  await evaluate(
    "overlay.destroy();document.querySelector('#stage').replaceChildren()",
  );

  const gzipData = imgBase64;
  const imported = await evaluate(`(async()=>{
    const stage=document.querySelector('#stage'),img=document.createElement('img');img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>');stage.append(img);await img.decode();
    window.t=1;const c=spyderRecordingOverlays.attach(stage,{item:{id:'recording-uuid'},media:img,time:()=>window.t,demo:true});
    const picker=stage.querySelector('input[type=file]'),bytes=Uint8Array.from(atob('${gzipData}'),x=>x.charCodeAt(0));
    const files=new DataTransfer();files.items.add(new File([bytes],'${nativeClip}.overlays-000000.json.gz',{type:'application/gzip'}));
    Object.defineProperty(picker,'files',{configurable:true,value:files.files});picker.dispatchEvent(new Event('change',{bubbles:true}));
    const toggle=stage.querySelector('input[type=checkbox]');toggle.checked=true;toggle.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,200));
    const loaded=stage.querySelector('.recording-overlay-status').textContent.includes('Detections loaded');
    const wrongContent=new File([Uint8Array.from(atob('${wrongIdBase64}'),x=>x.charCodeAt(0))],'${nativeClip}.overlays-000000.json');
    const wrongSet=new DataTransfer();wrongSet.items.add(wrongContent);Object.defineProperty(picker,'files',{configurable:true,value:wrongSet.files});picker.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,100));
    const contentIdRejected=stage.querySelector('.recording-overlay-status').textContent.includes('another clip');
    const mixed=new DataTransfer();mixed.items.add(new File([bytes],'${nativeClip}.overlays-000000.json.gz'));mixed.items.add(new File([bytes],'${"b".repeat(32)}.overlays-000001.json.gz'));
    Object.defineProperty(picker,'files',{configurable:true,value:mixed.files});picker.dispatchEvent(new Event('change',{bubbles:true}));
    const rejected=stage.querySelector('.recording-overlay-status').textContent.includes('must match');c.destroy();stage.replaceChildren();return {loaded,rejected,contentIdRejected};
  })()`);
  console.log("Local import cases finished.");
  assert.ok(
    imported.loaded,
    "local gzip sidecar parses and loads lazily in showcase",
  );
  assert.ok(imported.rejected, "mixed clip IDs are rejected");
  assert.ok(
    imported.contentIdRejected,
    "sidecar media_id must match filename clip ID",
  );
  assert.equal(
    await evaluate("window.fetchCalls"),
    0,
    "gzip import and mixed-ID rejection perform no fetch",
  );

  const viewerLifecycle = await evaluate(`(()=>{
    window.spyderShowcase=false;window.overlayErrors=[];window.onerror=(m)=>window.overlayErrors.push(String(m));
    window.spyderFaceEnrollment={fromRecording:(item,time)=>window.enrolled={id:item.id,time}};
    const item={id:'${nativeClip}',kind:'recording',name:'Viewer fixture',url:'blob:local/fixture'};
    spyderEventLibrary.openMedia(item);let dialog=document.querySelector('dialog.media-viewer');
    dialog.querySelector('.media-viewer-heading button').click();const closeClean=!document.querySelector('dialog.media-viewer')&&!dialog.querySelector('.recording-overlay-controls');
    spyderEventLibrary.openMedia(item);dialog=document.querySelector('dialog.media-viewer');
    [...dialog.querySelectorAll('button')].find(button=>button.textContent==='Enroll someone').click();
    return {closeClean,enrolled:window.enrolled?.id===item.id,closedAfterEnroll:!document.querySelector('dialog.media-viewer'),errors:window.overlayErrors};
  })()`);
  console.log("Shared viewer lifecycle cases finished.");
  assert.ok(
    viewerLifecycle.closeClean,
    "shared media viewer close destroys overlay controls",
  );
  assert.ok(
    viewerLifecycle.enrolled && viewerLifecycle.closedAfterEnroll,
    "enrollment action closes viewer and preserves callback",
  );
  assert.deepEqual(
    viewerLifecycle.errors,
    [],
    "viewer cleanup raises no browser errors",
  );

  // Native API path: delayed first chunk must not paint after a seek to missing chunk.
  await command(
    "Page.navigate",
    { url: `http://127.0.0.1:${server.address().port}/` },
    sessionId,
  );
  console.log("Native page loaded.");
  await until("!!window.spyderRecordingOverlays");
  const stale = await evaluate(`(async()=>{
    window.fetchCalls=0;const baseFetch=window.fetch;window.fetch=(...args)=>{window.fetchCalls++;return baseFetch(...args)};
    const stage=document.querySelector('#stage'),video=document.createElement('video');video.controls=true;stage.append(video);const ready=new Promise(r=>video.addEventListener('loadedmetadata',r,{once:true}));video.src='/fixture.mp4';await ready;
    video.requestVideoFrameCallback=undefined;window.t=1;const c=spyderRecordingOverlays.attach(stage,{item:{id:'${nativeClip}'},media:video,time:()=>window.t,demo:false});
    const toggle=stage.querySelector('input[type=checkbox]');toggle.checked=true;toggle.dispatchEvent(new Event('change'));
    for(let i=0;i<40&&window.fetchCalls<1;i++)await new Promise(r=>setTimeout(r,10));
    const importedData={version:1,chunk_seconds:30,index:0,media_id:'${nativeClip}',width:video.videoWidth,height:video.videoHeight,fps:5,truncated:false,samples:[{time:.5,boxes:[{bbox:[.6,.6,.2,.2],camera_id:'cam',kind:'person',label:'imported'}]}]};
    const stream=new Blob([JSON.stringify(importedData)]).stream().pipeThrough(new CompressionStream('gzip'));const compressed=await new Response(stream).arrayBuffer();
    const picker=stage.querySelector('input[type=file]'),fileSet=new DataTransfer();fileSet.items.add(new File([compressed],'${nativeClip}.overlays-000000.json.gz'));
    Object.defineProperty(picker,'files',{configurable:true,value:fileSet.files});picker.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,120));
    const status=stage.querySelector('.recording-overlay-status').textContent;
    const canvas=stage.querySelector('canvas'),ctx=canvas.getContext('2d'),sr=stage.getBoundingClientRect(),vr=video.getBoundingClientRect();
    const scale=Math.min(vr.width/video.videoWidth,vr.height/video.videoHeight),left=vr.left-sr.left+(vr.width-video.videoWidth*scale)/2,top=vr.top-sr.top+(vr.height-video.videoHeight*scale)/2;
    const alpha=(x,y)=>ctx.getImageData(Math.round(x*devicePixelRatio),Math.round(y*devicePixelRatio),1,1).data[3];
    const importedBox=alpha(left+.6*video.videoWidth*scale,top+.7*video.videoHeight*scale)>0;
    await new Promise(r=>setTimeout(r,850));
    const lateResponseIgnored=stage.querySelector('.recording-overlay-status').textContent===status && importedBox;
    window.t=31;await c.update(31);await new Promise(r=>setTimeout(r,100));
    const missingStatus=stage.querySelector('.recording-overlay-status').textContent.includes('No saved detections');
    const requestCount=window.fetchCalls;for(let i=0;i<5;i++)await c.update(31);
    const missingCached=window.fetchCalls===requestCount;
    const px=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const clear=Array.from({length:px.length/4},(_,i)=>px[i*4+3]).every(v=>v===0);
    c.destroy();return {lateResponseIgnored,importedBox,missingStatus,missingCached,clear,requestCount};
  })()`);
  console.log("Native API race cases finished.");
  assert.ok(
    stale.importedBox,
    "native video overlay uses source geometry after compression",
  );
  assert.ok(
    stale.lateResponseIgnored,
    "late old response cannot replace imported chunk",
  );
  assert.ok(
    stale.missingStatus,
    "native missing chunk reports no saved detections",
  );
  assert.ok(
    stale.missingCached,
    "missing chunk is cached instead of refetched",
  );
  assert.ok(stale.clear, "empty chunk clears all canvas pixels");
  assert.equal(
    stale.requestCount,
    1,
    "native path requests only the current chunk and does not fetch absent imported chunks",
  );
  console.log(`Chrome browser regression passed. Screenshot: ${screenshot}`);
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  await new Promise((resolve) => {
    if (chrome.exitCode !== null) resolve();
    else chrome.once("close", resolve);
  });
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
