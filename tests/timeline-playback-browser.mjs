// Static browser regression. Run: node tests/recording-library-browser.mjs <showcase-dir>
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
assert.ok(
  policy?.includes("connect-src 'none'"),
  "Showcase CSP must block network requests",
);
const fixture = (await readFile(path.resolve(process.argv[3]))).toString(
  "base64",
);
const paths = [];
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-recording-library-"),
);
const server = http.createServer(async (req, res) => {
  paths.push(req.url);
  const name =
    new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[\w.-]+$/.test(name)) return res.writeHead(404).end();
  try {
    res.setHeader("Content-Security-Policy", policy);
    res.setHeader(
      "Content-Type",
      path.extname(name) === ".js"
        ? "text/javascript"
        : path.extname(name) === ".css"
          ? "text/css"
          : path.extname(name) === ".svg"
            ? "image/svg+xml"
            : "text/html",
    );
    res.end(await readFile(path.join(assets, name)));
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
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error
      ? entry.reject(new Error(JSON.stringify(message.error)))
      : entry.resolve(message.result);
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
  async function until(expression) {
    for (let i = 0; i < 300; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error("Timed out: " + expression);
  }
  await until(
    "!!window.spyderRecordingTimeline && !!window.spyderRecordingPlayer && !!window.spyderBrowserMedia",
  );
  await evaluate(`(async()=>{
    const bytes=Uint8Array.from(atob(${JSON.stringify(fixture)}),c=>c.charCodeAt(0));
    window.importedLocalVideo=await spyderBrowserMedia.importVideo(new File([bytes],'local-original.mp4',{type:'video/mp4'}));
  })()`);
  assert.equal(
    await evaluate("importedLocalVideo.local_file"),
    true,
    "Showcase opens file-backed local video without uploading it",
  );
  assert.equal(
    await evaluate("importedLocalVideo.url.startsWith('blob:')"),
    true,
  );
  assert.ok(await evaluate("importedLocalVideo.duration_seconds>=5"));
  await evaluate(`(()=>{
    window.timelineErrors=[];window.addEventListener('error',e=>timelineErrors.push(e.message));
    navigator.mediaDevices.getUserMedia=()=>{throw Error('Unexpected camera access')};
    const bytes=Uint8Array.from(atob(${JSON.stringify(fixture)}),c=>c.charCodeAt(0));
    window.timelineBlob=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
    window.timelineStart=new Date(2026,9,22,9,0,0).getTime();
    window.timelineItems=[0,1,2].map((index)=>({id:['a','b','c'][index].repeat(32),kind:'recording',filename:'Camera wall '+(index+1)+'.mp4',created_at:new Date(timelineStart+[0,4000,18000][index]).toISOString(),duration_seconds:4,size_bytes:bytes.length,url:timelineBlob,camera_ids:index===2?['cam-b']:['cam-a']}));
    window.timelineSnapshot={state:'idle',camera_ids:[],elapsed_seconds:0,items:timelineItems};
    spyderBrowserMedia.status=()=>timelineSnapshot;location.hash='recordings';
  })()`);
  await until("document.querySelector('#recording-timeline-tab')");
  await evaluate("document.querySelector('#recording-timeline-tab').click()");
  await until(
    "document.querySelectorAll('.recording-timeline-toolbar input[type=date]').length===1",
  );
  await evaluate(
    "document.querySelector('.recording-timeline-toolbar input[type=date]').value='2026-10-22';document.querySelector('.recording-timeline-toolbar input[type=date]').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await until(
    "document.querySelectorAll('.recording-timeline-clip').length===3",
  );
  await evaluate(
    "document.querySelector('.recording-timeline-clips button').click()",
  );
  await until(
    "document.querySelector('.recording-timeline-player video')?.readyState>=1",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.recording-timeline-player video').error",
    ),
    null,
  );
  await evaluate(
    "document.querySelector('.recording-timeline-player video').pause();document.querySelector('.recording-timeline-toolbar input[type=datetime-local]').value='2026-10-22T09:00:02';document.querySelector('.recording-timeline-toolbar input[type=datetime-local]').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await until(
    "Math.abs(document.querySelector('.recording-timeline-player video').currentTime-2)<.25",
  );
  await evaluate(
    "window.loadedTimelineVideo=document.querySelector('.recording-timeline-player video')",
  );
  await delay(1600);
  assert.equal(
    await evaluate(
      "loadedTimelineVideo===document.querySelector('.recording-timeline-player video')",
    ),
    true,
    "Polling must preserve video",
  );
  await evaluate(
    "loadedTimelineVideo.currentTime=3.9;loadedTimelineVideo.dispatchEvent(new Event('ended'))",
  );
  await until(
    "document.querySelector('.recording-timeline-loaded').textContent==='Camera wall 2.mp4'",
  );
  await until(
    "document.querySelector('.recording-timeline-player video').readyState>=1",
  );
  await evaluate(
    "document.querySelector('.recording-timeline-player video').dispatchEvent(new Event('ended'))",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.recording-timeline-loaded').textContent",
    ),
    "Camera wall 2.mp4",
    "Default playback stops before a gap",
  );
  await evaluate(
    "document.querySelector('.recording-timeline-check input').checked=true;document.querySelector('.recording-timeline-player video').dispatchEvent(new Event('ended'))",
  );
  await until(
    "document.querySelector('.recording-timeline-loaded').textContent==='Camera wall 3.mp4'",
  );
  await evaluate(
    "document.querySelector('.recording-timeline-toolbar input[type=datetime-local]').value='2026-10-22T09:00:12';document.querySelector('.recording-timeline-toolbar input[type=datetime-local]').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await until(
    "document.querySelector('.recording-timeline-player').textContent.includes('No saved footage')",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('.recording-timeline video')].every(v=>v.paused)",
    ),
    true,
  );
  await evaluate(
    "document.querySelector('.recording-timeline-toolbar select').value='cam-b';document.querySelector('.recording-timeline-toolbar select').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.recording-timeline-clip').length",
    ),
    1,
  );
  await evaluate("document.querySelector('#recording-library-tab').click()");
  await until("!document.querySelector('.recording-timeline')");
  await evaluate(
    "[...document.querySelectorAll('#media-library button')].find(b=>b.textContent==='Show on timeline').click()",
  );
  await until(
    "document.querySelector('.recording-timeline-player video')?.readyState>=1",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#recording-timeline-tab').getAttribute('aria-pressed')",
    ),
    "true",
  );
  // Scale only saved metadata. Reuse one tiny blob; no camera or inference starts.
  await evaluate(
    `timelineSnapshot.items=Array.from({length:5000},(_,i)=>({id:'bulk-'+i,kind:'recording',filename:'Historical clip '+i,created_at:new Date(timelineStart+i*1000).toISOString(),duration_seconds:4,url:timelineBlob}));`,
  );
  await until(
    "document.querySelector('.recording-timeline-list-head').textContent.includes('5000')",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.recording-timeline-clip').length",
    ),
    25,
  );
  assert.ok(
    await evaluate(
      "document.querySelectorAll('.recording-timeline-bin').length<=720",
    ),
  );
  await evaluate(
    "document.querySelector('.recording-timeline-pagination button:last-child').click()",
  );
  await delay(1600);
  assert.match(
    await evaluate(
      "document.querySelector('.recording-timeline-pagination span').textContent",
    ),
    /Page 2/,
  );
  for (const theme of ["light", "dark"])
    for (const [width, height] of [
      [1280, 800],
      [640, 340],
      [390, 640],
      [320, 480],
    ]) {
      await command(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: width < 500 },
        sessionId,
      );
      await evaluate(
        `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
      );
      await evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const layout = await evaluate(
        `(()=>{const p=document.querySelector('.recording-timeline');return{doc:document.documentElement.scrollWidth,viewport:innerWidth,panel:p.scrollWidth,client:p.clientWidth,range:document.querySelector('.recording-timeline-range').getBoundingClientRect().width,track:document.querySelector('.recording-timeline-track').getBoundingClientRect().width}})()`,
      );
      assert.ok(
        layout.doc <= width + 1,
        JSON.stringify({ theme, width, height, layout }),
      );
      assert.ok(layout.panel <= layout.client + 1);
      assert.ok(Math.abs(layout.range - layout.track) < 3);
      if (
        (width === 1280 && theme === "light") ||
        (width === 390 && theme === "dark")
      ) {
        const shot = await command(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: true },
          sessionId,
        );
        await writeFile(
          path.join(assets, "..", `timeline-${theme}-${width}.png`),
          Buffer.from(shot.data, "base64"),
        );
      }
    }
  await evaluate("location.hash='control-room'");
  await until("!document.querySelector('.recording-timeline')");

  await evaluate(`(()=>{
    const host=document.createElement('div');host.id='timeline-extra';document.querySelector('main').append(host);
    window.timelineLoads=[];
    const midnight=new Date(2026,9,22,23,59,58).getTime();
    const clip={id:'midnight',kind:'recording',filename:'Midnight crossing',created_at:new Date(midnight).toISOString(),duration_seconds:4,url:timelineBlob,camera_ids:['cam-a']};
    window.extraTimeline=spyderRecordingTimeline.mount(host,[clip],{
      cameras:()=>[{id:'cam-a',name:'Front'},{id:'cam-b',name:'Rear'}],
      events:()=>[{name:'Face',created_at:new Date(midnight+1000).toISOString(),camera_id:'cam-a'},{name:'Motion',created_at:new Date(midnight+500).toISOString(),camera_id:'cam-b'}],
      createPlayer:(_host,callbacks)=>({load:(item,options)=>{timelineLoads.push(options);callbacks.onTime(options.offset)},seek:seconds=>callbacks.onTime(seconds),play(){},pause(){},setRate(){},destroy(){}})
    });
  })()`);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#timeline-extra .recording-timeline-event-button').length",
    ),
    2,
  );
  await evaluate(
    "document.querySelector('#timeline-extra .recording-timeline-toolbar select').value='cam-a';document.querySelector('#timeline-extra .recording-timeline-toolbar select').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#timeline-extra .recording-timeline-event-button').length",
    ),
    1,
  );
  await evaluate(
    "document.querySelector('#timeline-extra .recording-timeline-event-button').click()",
  );
  assert.equal(await evaluate("timelineLoads.at(-1).offset"), 1);
  await evaluate(
    "document.querySelector('#timeline-extra input[type=datetime-local]').value='2026-10-23T00:00:01';document.querySelector('#timeline-extra input[type=datetime-local]').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  assert.equal(await evaluate("timelineLoads.at(-1).offset"), 3);
  assert.equal(
    await evaluate(
      "document.querySelector('#timeline-extra input[type=date]').value",
    ),
    "2026-10-23",
  );
  await evaluate("extraTimeline.unmount()");

  await until("!!window.spyderEventLibrary");
  await evaluate(`(()=>{
    window.spyderShowcase=undefined;
    window.recordingEnrollCalls=[];window.enrollOrder=[];
    window.spyderFaceEnrollment={fromRecording:(item,seconds)=>{enrollOrder.push('enroll');recordingEnrollCalls.push({item,seconds,viewerOpen:!!document.querySelector('.media-viewer')})}};
    const host=document.createElement('div');host.id='timeline-enroll';document.querySelector('main').append(host);
    const recording={id:'0123456789abcdef0123456789abcdef',kind:'recording',filename:'Enrollment source',created_at:new Date().toISOString(),duration_seconds:20};
    window.enrollTimelineItem=recording;
    window.enrollTimeline=spyderRecordingTimeline.mount(host,[],{createPlayer:(_host,callbacks)=>{
      const video=document.createElement('video');Object.defineProperty(video,'currentTime',{configurable:true,writable:true,value:1});_host.append(video);
      window.enrollTimelineCallbacks=callbacks;
      return {load(_item,options){callbacks.onTime(options.offset)},seek(seconds){callbacks.onTime(seconds)},play(){},pause(){enrollOrder.push('pause')},setRate(){},destroy(){enrollOrder.push('destroy')}};
    }});
    enrollTimeline.setItems([recording]);
  })()`);
  assert.equal(
    await evaluate(
      "document.querySelector('#timeline-enroll .recording-timeline-player-controls button:nth-child(4)').disabled",
    ),
    true,
    "Timeline enrollment stays disabled without selected clip",
  );
  await evaluate(
    "document.querySelector('#timeline-enroll .recording-timeline-clip-actions button').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#timeline-enroll .recording-timeline-player-controls button:nth-child(4)').disabled",
    ),
    false,
  );
  await evaluate(
    "document.querySelector('#timeline-enroll .recording-timeline-player video').currentTime=6.4;document.querySelector('#timeline-enroll .recording-timeline-player-controls button:nth-child(4)').click()",
  );
  assert.equal(
    await evaluate("recordingEnrollCalls.at(-1).item.id"),
    "0123456789abcdef0123456789abcdef",
  );
  assert.equal(await evaluate("recordingEnrollCalls.at(-1).seconds"), 6.4);
  assert.deepEqual(await evaluate("enrollOrder"), [
    "pause",
    "destroy",
    "enroll",
  ]);
  await evaluate("enrollTimeline.unmount()");
  await evaluate(`(()=>{
    const host=document.createElement('div');host.id='timeline-enroll-compat';document.querySelector('main').append(host);
    window.compatTimeline=spyderRecordingTimeline.mount(host,[enrollTimelineItem],{createPlayer:(_host,callbacks)=>{
      const video=document.createElement('video');video.hidden=true;_host.append(video);window.compatTimelineCallbacks=callbacks;
      return {load(_item,options){callbacks.onTime(options.offset)},seek(seconds){callbacks.onTime(seconds)},play(){},pause(){enrollOrder.push('pause')},setRate(){},destroy(){enrollOrder.push('destroy')}};
    }});
  })()`);
  await evaluate(
    "document.querySelector('#timeline-enroll-compat .recording-timeline-clip-actions button').click()",
  );
  await evaluate(
    "compatTimelineCallbacks.onTime(8.15);document.querySelector('#timeline-enroll-compat .recording-timeline-player-controls button:nth-child(4)').click()",
  );
  assert.equal(await evaluate("recordingEnrollCalls.at(-1).seconds"), 8.15);
  assert.deepEqual(await evaluate("enrollOrder.slice(-3)"), [
    "pause",
    "destroy",
    "enroll",
  ]);
  await evaluate("compatTimeline.unmount()");

  await evaluate(`(()=>{
    const native={id:'abcdef0123456789abcdef0123456789',kind:'recording',url:timelineBlob,name:'Native enrollment'};
    window.nativeEnrollmentItem=native;
    spyderEventLibrary.openMedia(native);
    const video=document.querySelector('.media-viewer video');Object.defineProperty(video,'currentTime',{configurable:true,writable:true,value:3.25});
    window.nativeViewerVideo=video;
  })()`);
  assert.equal(
    await evaluate(
      "document.querySelector('.media-viewer button').textContent",
    ),
    "",
  );
  await evaluate(
    "[...document.querySelectorAll('.media-viewer button')].find(button=>button.textContent==='Enroll someone').click()",
  );
  assert.equal(
    await evaluate("recordingEnrollCalls.at(-1).item.id"),
    "abcdef0123456789abcdef0123456789",
  );
  assert.equal(await evaluate("recordingEnrollCalls.at(-1).seconds"), 3.25);
  assert.equal(await evaluate("recordingEnrollCalls.at(-1).viewerOpen"), false);
  assert.equal(await evaluate("nativeViewerVideo.paused"), true);

  await evaluate(`(()=>{
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(url,options)=>String(url).endsWith('/info')?new Response(JSON.stringify({duration_seconds:12}),{status:200,headers:{'Content-Type':'application/json'}}):String(url).includes('/frame?time=')?new Response(new Blob(['frame'],{type:'image/jpeg'}),{status:200}):originalFetch(url,options);
    const fallback={id:'fedcba9876543210fedcba9876543210',kind:'recording',url:'/api/media/fedcba9876543210fedcba9876543210',name:'Fallback enrollment'};
    spyderEventLibrary.openMedia(fallback);
    document.querySelector('.media-viewer video').dispatchEvent(new Event('error'));
  })()`);
  await until("!!document.querySelector('.media-viewer input[type=range]')");
  await evaluate(
    "(()=>{const seek=document.querySelector('.media-viewer input[type=range]');seek.value='5.8';seek.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('.media-viewer button')].find(button=>button.textContent==='Enroll someone').click()})()",
  );
  assert.equal(
    await evaluate("recordingEnrollCalls.at(-1).item.id"),
    "fedcba9876543210fedcba9876543210",
  );
  assert.equal(await evaluate("recordingEnrollCalls.at(-1).seconds"), 5.8);
  assert.equal(await evaluate("recordingEnrollCalls.at(-1).viewerOpen"), false);

  await evaluate(
    "spyderEventLibrary.openMedia({id:'0123456789abcdef0123456789abcdef',kind:'capture',url:timelineBlob})",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('.media-viewer button')].some(button=>button.textContent==='Enroll someone')",
    ),
    false,
  );
  await evaluate(
    "spyderEventLibrary.closeMedia();window.spyderShowcase={};spyderEventLibrary.openMedia({id:'0123456789abcdef0123456789abcdef',kind:'recording',url:timelineBlob})",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('.media-viewer button')].some(button=>button.textContent==='Enroll someone')",
    ),
    false,
  );
  await evaluate(
    "spyderEventLibrary.closeMedia();window.spyderShowcase=undefined",
  );
  assert.equal(await evaluate("recordingEnrollCalls.length"), 4);
  assert.equal(
    paths.some((url) =>
      /\/api\/(faces\/galleries|faces\/enroll|face-enrollment)/.test(url),
    ),
    false,
  );
  assert.deepEqual(await evaluate("timelineErrors"), []);
  assert.equal(
    paths.some((url) => url.startsWith("/api/")),
    false,
  );
  console.log(
    "PASS: actual MP4 playback, wall-clock seeking, contiguous clips and gap handling, camera filtering, library shortcut, 5000 clips, refresh stability, responsive themes, cleanup and static CSP/no APIs.",
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
