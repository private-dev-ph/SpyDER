import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const root = path.resolve(
  process.env.SPYDER_ASSET_ROOT || "src/spyder_cctv/assets",
);
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-device-tools-browser-"),
);
const screenshotDir = path.resolve(".pytest_cache/enrollment-studio");
const html =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/device-tools.css"><link rel="stylesheet" href="/face-enrollment-viewer.css"><style>body{font-family:system-ui,sans-serif}:root{--surface:#fffefa;--canvas:#f7f5ef;--ink:#201d1a;--muted:#726d64;--border:#e4dfd4;--control-border:#8c8274;--focus:#830000;--accent:#be1a1a;--accent-hover:#830000;--danger:#bc0202;--gold-soft:#f8ebab}html[data-theme=dark]{--surface:#1e1c1b;--canvas:#141313;--ink:#f5efe4;--muted:#b0a69b;--border:#37312c;--focus:#f7d87f;--danger:#ff827b}</style></head><body><main><div id="face-gallery-tools"></div><div id="onvif-camera-tools"></div></main><script>' +
  'window.testJpeg=(()=>{const c=document.createElement("canvas");c.width=160;c.height=160;const ctx=c.getContext("2d");ctx.fillStyle="#f8ebab";ctx.fillRect(0,0,160,160);ctx.fillStyle="#be1a1a";ctx.beginPath();ctx.arc(80,54,28,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.ellipse(80,147,52,49,0,0,Math.PI*2);ctx.fill();return c.toDataURL("image/jpeg")})();const nativeFetch=window.fetch.bind(window);window.calls=[];window.runtimeErrors=[];window.galleryIdentityCount=1;window.gallerySampleCount=1;window.holdAnalyze=false;window.analyzeStarted=false;window.resolveAnalyze=null;window.addEventListener("error",e=>runtimeErrors.push(e.message));window.spyder={cameras:()=>[{id:"cam-1",name:"Lobby"}]};if(location.search.includes("showcase"))window.spyderShowcase={};window.fetch=async(url,opts={})=>{const method=opts.method||"GET",path=String(url),body=opts.body?JSON.parse(opts.body):null;if(path==="/test-video.mp4")return nativeFetch(url,opts);calls.push({path,method,body});if(window.holdAnalyze&&path.endsWith("/analyze"))return await new Promise(resolve=>{window.analyzeStarted=true;window.resolveAnalyze=()=>{window.holdAnalyze=false;resolve(new Response(JSON.stringify({review_token:"late-review",preview:window.testJpeg,width:640,height:480,faces:[{index:0,bbox:[.1,.1,.4,.5],confidence:.97,thumbnail:window.testJpeg}]}),{status:200,headers:{"Content-Type":"application/json"}}))}});if(path.endsWith("/preview-frame"))return new Response(Uint8Array.from(atob(window.testJpeg.split(",")[1]),c=>c.charCodeAt(0)),{status:200,headers:{"Content-Type":"image/jpeg"}});let data={};' +
  'if(path==="/api/models")data={models:[{id:"det-1",name:"Detector",engine:"insightface",metadata:{model_type:"face_detection"}},{id:"rec-1",name:"Recognizer",engine:"insightface",metadata:{model_type:"face_recognition"}}]};' +
  'else if(path==="/api/faces/galleries"&&method==="GET")data={galleries:[{id:"g1",name:"Lobby",identity_count:window.galleryIdentityCount,sample_count:window.gallerySampleCount,thumbnail:window.testJpeg},{id:"g2",name:"Office",identity_count:1,sample_count:1}]};' +
  'else if(path.endsWith("/identities/i1/samples/s1/remove")){window.gallerySampleCount=0;data={};}' +
  'else if(path.endsWith("/identities/i1/remove")){window.galleryIdentityCount=0;window.gallerySampleCount=0;data={};}' +
  'else if(path==="/api/faces/galleries/g1"&&method==="GET")data={id:"g1",name:"Lobby",detector_model_id:"det-1",recognition_model_id:"rec-1",identities:window.galleryIdentityCount?[{id:"i1",name:"Ada",thumbnail:window.testJpeg,samples:window.gallerySampleCount?[{id:"s1",thumbnail:window.testJpeg}]:[]}]:[]};' +
  'else if(path==="/api/faces/galleries/g2"&&method==="GET")data={id:"g2",name:"Office",identities:[{id:"legacy",name:"Legacy profile",samples:[{id:"old-sample"}]}]};' +
  'else if(path==="/api/faces/galleries"&&method==="POST")data={id:"g1"};else if(path.endsWith("/analyze")&&method==="POST")data={review_token:"review-1",preview:window.testJpeg,width:640,height:480,faces:[{index:0,bbox:[.1,.1,.4,.5],confidence:.97,thumbnail:window.testJpeg},{index:1,bbox:[.5,.1,.9,.5],confidence:.82,thumbnail:window.testJpeg}]};else if(path.endsWith("/enroll-reviewed")&&method==="POST")data={};' +
  'else if(path==="/api/onvif/discover")data={devices:[{endpoint:"http://192.168.1.8/onvif/device_service",name:"Mock cam"}]};else if(path==="/api/onvif/connect")data={session_id:"s-1",device:{name:"Mock cam"},profiles:[{token:"p-1",name:"Main",ptz:true},{token:"p-2",name:"No PTZ",ptz:true,ptz_caps:{pan_tilt:false,zoom:false}}],ptz:{pan_tilt:true,zoom:false}};else if(path==="/api/onvif/sessions")data={sessions:[{session_id:"s-1",device:{name:"Mock cam"},profiles:[{token:"p-1",name:"Main",ptz:true}],ptz:{pan_tilt:true,zoom:false}}]};else if(path==="/api/onvif/add")data={message:"Added"};return new Response(JSON.stringify(data),{status:200,headers:{"Content-Type":"application/json"}})};</script><script src="/face-enrollment-viewer.js"></script><script src="/device-tools.js"></script></body></html>';
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname;
  if (name === "/test-video.mp4") {
    res.setHeader("Content-Type", "video/mp4");
    res.end(
      await readFile(
        path.resolve(root, "../../../tests/fixtures/enrollment-range.mp4"),
      ),
    );
    return;
  }
  if (name === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }
  const file =
    name === "/device-tools.js" || name === "/device-tools.css"
      ? path.basename(name)
      : name === "/face-enrollment-viewer.js" ||
          name === "/face-enrollment-viewer.css"
        ? path.basename(name)
        : null;
  if (!file) return res.writeHead(404).end();
  res.setHeader(
    "Content-Type",
    file.endsWith(".css") ? "text/css" : "text/javascript",
  );
  res.end(await readFile(path.join(root, file)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const chrome = spawn(
  process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
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
    await fetch("http://127.0.0.1:" + port + "/json/version")
  ).json();
  socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (!m.id) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
  };
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Timed out: " + method));
        }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const t = await command("Target.createTarget", { url: "about:blank" }),
    attached = await command("Target.attachToTarget", {
      targetId: t.targetId,
      flatten: true,
    }),
    sid = attached.sessionId;
  const evaluate = async (expr) => {
    const r = await command(
      "Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true },
      sid,
    );
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const until = async (expr) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expr)) return;
      await delay(50);
    }
    throw Error(
      "Timed out: " +
        expr +
        "; " +
        JSON.stringify(
          await evaluate(
            "({text:document.body.innerText.slice(0,400),dialogs:Array.from(document.querySelectorAll('dialog')).map(d=>({className:d.className,open:d.open,html:d.innerHTML.slice(0,180)})),create:{busy:document.querySelector('#face-gallery-tools')?._creatingGallery,disabled:document.querySelector('#face-gallery-tools [data-create]')?.disabled},runtimeErrors,calls})",
          ),
        ),
    );
  };
  const click = (selector) =>
    evaluate(
      "(()=>{const e=document.querySelector(" +
        JSON.stringify(selector) +
        ");if(!e)throw Error('Missing button '+" +
        JSON.stringify(selector) +
        ");e.click()})()",
    );
  await command(
    "Page.navigate",
    { url: "http://127.0.0.1:" + server.address().port + "/" },
    sid,
  );
  await until("!!document.querySelector('#onvif-camera-tools .dt-card')");
  await until(
    "calls.some(x=>x.path==='/api/faces/galleries' && x.method==='GET')",
  );
  await until("!!document.querySelector('#face-gallery-tools [data-gid=g1]')");
  await evaluate(
    "window.spyder.cameras=()=>[{id:'cam-1',name:'<img src=x onerror=window.pwned=1>'}]",
  );
  assert.equal(
    await evaluate(
      "calls.filter(x=>x.path==='/api/faces/galleries' && x.method==='GET').length",
    ),
    1,
    "Native mode loads galleries on mount",
  );
  await click("#face-gallery-tools [data-refresh]");
  await until("!!document.querySelector('#face-gallery-tools [data-gid=g1]')");
  await click("#face-gallery-tools [data-gid=g1]");
  await until(
    "document.querySelector('#face-gallery-tools').innerText.includes('Ada')",
  );
  assert.equal(
    await evaluate(
      "!!document.querySelector('#face-gallery-tools .dt-identity img[src^=\"data:image/jpeg;base64,\"]')",
    ),
    true,
    "An enrolled identity shows its stored portrait instead of only sample IDs",
  );
  assert.equal(
    await evaluate(
      "!!document.querySelector('#face-gallery-tools .dt-sample img')",
    ),
    true,
    "Enrollment samples show cropped face thumbnails",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#face-gallery-tools .dt-sample-name').textContent",
    ),
    "Sample 1",
    "Sample rows use readable labels instead of raw identifiers",
  );
  await click("#face-gallery-tools [data-gid=g2]");
  await until("!!document.querySelector('[data-enroll-identity=legacy]')");
  assert.ok(
    await evaluate(
      "document.querySelector('.dt-identity').innerText.includes('No portrait yet')",
    ),
    "Older profiles explain how to add a portrait without losing their existing samples",
  );
  await click("[data-enroll-identity=legacy]");
  await until("!!document.querySelector('dialog.fe-studio[open]')");
  assert.equal(
    await evaluate("document.querySelector('[data-fe-name]').value"),
    "Legacy profile",
    "Add sample opens the studio with the existing identity selected",
  );
  await click("[data-fe-close]");
  await until("!document.querySelector('dialog.fe-studio')");
  await click("#face-gallery-tools [data-gid=g1]");
  await until("!!document.querySelector('.dt-identity img')");
  await until(
    "[...document.querySelectorAll('.dt-identity img')].every(img=>img.complete&&img.naturalWidth>0)",
  );
  await mkdir(screenshotDir, { recursive: true });
  const galleryShot = await command(
    "Page.captureScreenshot",
    { format: "png" },
    sid,
  );
  await writeFile(
    path.join(screenshotDir, "gallery-portraits.png"),
    Buffer.from(galleryShot.data, "base64"),
  );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 700, deviceScaleFactor: 1, mobile: true },
    sid,
  );
  assert.ok(
    await evaluate("document.documentElement.scrollWidth<=innerWidth"),
    "Portrait cards and sample actions fit a mobile gallery without horizontal overflow",
  );
  const mobileGalleryShot = await command(
    "Page.captureScreenshot",
    { format: "png" },
    sid,
  );
  await writeFile(
    path.join(screenshotDir, "gallery-portraits-mobile.png"),
    Buffer.from(mobileGalleryShot.data, "base64"),
  );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    sid,
  );
  await click("#face-gallery-tools [data-create]");
  await until("!!document.querySelector('.dt-dialog[open]')");
  assert.equal(
    await evaluate("document.querySelector('.dt-dialog select').required"),
    true,
  );
  await evaluate("document.querySelector('.dt-dialog [value=cancel]').click()");
  await until("!document.querySelector('.dt-dialog')");
  assert.equal(
    await evaluate(
      "calls.some(x=>x.path==='/api/faces/galleries' && x.method==='POST')",
    ),
    false,
    "Cancel must bypass required fields without saving",
  );
  assert.equal(
    await evaluate(
      "document.activeElement === document.querySelector('#face-gallery-tools [data-create]')",
    ),
    true,
    "Closing create restores focus",
  );
  await click("#face-gallery-tools [data-create]");
  await until("!!document.querySelector('.dt-dialog[open]')");
  await evaluate(
    "(()=>{const d=document.querySelector('.dt-dialog');d.querySelector('[name=name]').value='New gallery';d.querySelector('[name=detector_model_id]').value='det-1';d.querySelector('[name=recognition_model_id]').value='rec-1';d.querySelector('[value=create]').click()})()",
  );
  await until(
    "!document.querySelector('.dt-dialog') && calls.some(x=>x.path==='/api/faces/galleries' && x.method==='POST')",
  );
  await until(
    "document.querySelector('#face-gallery-tools [data-detail]').innerText.includes('Enroll someone')",
  );
  assert.equal(
    await evaluate(
      "!!document.querySelector('#face-gallery-tools [data-detail] input, #face-gallery-tools [data-detail] select')",
    ),
    false,
    "Gallery detail has no duplicate enrollment inputs",
  );
  await evaluate(`(() => {
    document.querySelector('[data-enroll-open]').click();
  })()`);
  await until("!!document.querySelector('dialog.fe-studio[open]')");
  assert.equal(
    await evaluate(
      "!!document.querySelector('dialog.fe-studio img[onerror],dialog.fe-studio script')",
    ),
    false,
    "Untrusted camera label renders as text, never markup",
  );
  assert.equal(
    await evaluate("window.pwned"),
    undefined,
    "Untrusted camera label does not execute script",
  );
  assert.equal(
    await evaluate(
      "calls.some(x=>x.path.endsWith('/analyze')||x.path.endsWith('/enroll-reviewed'))",
    ),
    false,
    "Opening studio never analyzes or saves automatically",
  );
  await evaluate(
    "(()=>{const camera=document.querySelector('dialog.fe-studio [data-fe-camera]');camera.value='cam-1';camera.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  await evaluate(
    "(()=>{const s=document.querySelector('dialog.fe-studio [data-fe-source]');s.value='image';s.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  await evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const context=canvas.getContext('2d');context.fillStyle='#ff0000';context.fillRect(0,0,1920,1080);context.fillStyle='#0000ff';context.fillRect(960,540,960,540);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg'));
    const transfer=new DataTransfer();transfer.items.add(new File([blob],'face.jpg',{type:'image/jpeg'}));
    const input=document.querySelector('dialog.fe-studio [data-fe-file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await until(
    "document.querySelector('dialog.fe-studio [data-fe-inspect]')?.disabled===false",
  );
  await evaluate(
    "(()=>{const s=document.querySelector('dialog.fe-studio [data-fe-stage]'),r=s.getBoundingClientRect();s.setPointerCapture=()=>{};s.hasPointerCapture=()=>false;const p=(type,x,y)=>s.dispatchEvent(new PointerEvent(type,{pointerId:7,button:0,clientX:x,clientY:y,bubbles:true}));p('pointerdown',r.left+r.width*.1,r.top+r.height*.1);p('pointermove',r.right+20,r.bottom+20);p('pointerup',r.right+20,r.bottom+20)})()",
  );
  const focusedPixel = await evaluate(`(() => {
    const stage=document.querySelector('dialog.fe-studio [data-fe-stage]');
    return [...stage.getContext('2d').getImageData(Math.round(stage.width*.6),Math.round(stage.height*.6),1,1).data];
  })()`);
  assert.ok(
    focusedPixel[2] > 220 && focusedPixel[0] < 30,
    "Dragging focus on a downscaled source preserves the image under the pointer: " +
      JSON.stringify(focusedPixel),
  );
  await click("dialog.fe-studio [data-fe-inspect]");
  await until(
    "!!document.querySelector('dialog.fe-studio [data-fe-candidate]')",
  );
  const analyzed = await evaluate("calls.find(x=>x.path.endsWith('/analyze'))");
  assert.ok(
    Array.isArray(analyzed.body.roi),
    "ROI drag sends normalized crop to analyze API",
  );
  assert.ok(
    analyzed.body.roi.every((n) => n >= 0 && n <= 1),
    "ROI drag clamps crop coordinates to image bounds",
  );
  assert.ok(
    analyzed.body.roi[0] < 0.2 &&
      analyzed.body.roi[1] < 0.2 &&
      analyzed.body.roi[2] > 0.75 &&
      analyzed.body.roi[3] > 0.75,
    "ROI drag uses normalized x, y, width, height values",
  );
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('dialog.fe-studio [data-fe-candidate]')).some(b=>b.getAttribute('aria-pressed')==='true')",
    ),
    false,
    "Review candidates start excluded",
  );
  assert.equal(
    await evaluate("calls.some(x=>x.path.endsWith('/enroll-reviewed'))"),
    false,
    "Analysis never saves identity",
  );
  await evaluate(
    "document.querySelector('dialog.fe-studio [data-fe-candidate]').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('dialog.fe-studio [data-fe-candidate]').getAttribute('aria-pressed')",
    ),
    "true",
    "Candidate toggle explicitly includes selected face",
  );
  await evaluate(
    "document.querySelector('dialog.fe-studio [data-fe-name]').value=''",
  );
  await click("dialog.fe-studio [data-fe-save]");
  await delay(100);
  assert.equal(
    await evaluate("calls.some(x=>x.path.endsWith('/enroll-reviewed'))"),
    false,
    "Save requires explicit identity name",
  );
  await evaluate(
    "(()=>{const n=document.querySelector('dialog.fe-studio [data-fe-name]');n.value='Bea';n.dispatchEvent(new Event('input',{bubbles:true}))})()",
  );
  await click("dialog.fe-studio [data-fe-save]");
  await until("calls.some(x=>x.path.endsWith('/enroll-reviewed'))");
  const reviewed = await evaluate(
    "calls.find(x=>x.path.endsWith('/enroll-reviewed'))",
  );
  assert.equal(reviewed.method, "POST");
  assert.deepEqual(reviewed.body, {
    identity_name: "Bea",
    selections: [{ review_token: "review-1", face_index: 0 }],
  });
  assert.equal(
    await evaluate(
      "calls.some(x=>x.path.endsWith('/enroll')&&!x.path.endsWith('/enroll-reviewed'))",
    ),
    false,
    "Legacy enroll endpoint is never used",
  );
  await until("!document.querySelector('dialog.fe-studio')");
  await evaluate(
    "(()=>{window.holdAnalyze=true;window.analyzeStarted=false;document.querySelector('[data-enroll-open]').click()})()",
  );
  await until("!!document.querySelector('dialog.fe-studio[open]')");
  await evaluate(
    "(()=>{const s=document.querySelector('dialog.fe-studio [data-fe-source]');s.value='image';s.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  await evaluate(
    `(async()=>{const c=document.createElement('canvas');c.width=8;c.height=8;const b=await new Promise(r=>c.toBlob(r,'image/jpeg'));const t=new DataTransfer();t.items.add(new File([b],'late.jpg',{type:'image/jpeg'}));const f=document.querySelector('dialog.fe-studio [data-fe-file]');f.files=t.files;f.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
  await until(
    "document.querySelector('dialog.fe-studio [data-fe-inspect]')?.disabled===false",
  );
  await click("dialog.fe-studio [data-fe-inspect]");
  await until("window.analyzeStarted===true");
  await click("dialog.fe-studio [data-fe-close]");
  await until("!document.querySelector('dialog.fe-studio')");
  await evaluate("window.resolveAnalyze()");
  await delay(100);
  assert.equal(
    await evaluate(
      "!!document.querySelector('dialog.fe-studio [data-fe-candidate]')",
    ),
    false,
    "Late analysis response after close cannot restore stale review candidates",
  );
  assert.equal(
    await evaluate(
      "calls.filter(x=>x.path.endsWith('/enroll-reviewed')).length",
    ),
    1,
    "Late analysis response after close cannot commit another identity",
  );
  await evaluate(
    "(()=>{document.querySelector('[data-enroll-open]').click()})()",
  );
  await until("!!document.querySelector('dialog.fe-studio[open]')");
  await evaluate(
    "(()=>{const s=document.querySelector('dialog.fe-studio [data-fe-source]');s.value='video';s.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  await evaluate(
    `(async()=>{const response=await fetch('/test-video.mp4');const blob=await response.blob();const transfer=new DataTransfer();transfer.items.add(new File([blob],'enrollment-range.mp4',{type:'video/mp4'}));const input=document.querySelector('dialog.fe-studio [data-fe-file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
  await until(
    "document.querySelector('dialog.fe-studio [data-fe-sample-video]')?.disabled===false",
  );
  await evaluate(
    "(()=>{const start=document.querySelector('dialog.fe-studio [data-fe-start]');start.value='1';start.dispatchEvent(new Event('input',{bubbles:true}));start.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  await until(
    "document.querySelector('dialog.fe-studio [data-fe-range]').textContent.includes('1.0s')",
  );
  const analyzesBeforeVideo = await evaluate(
    "calls.filter(x=>x.path.endsWith('/analyze')).length",
  );
  const savesBeforeVideo = await evaluate(
    "calls.filter(x=>x.path.endsWith('/enroll-reviewed')).length",
  );
  await click("dialog.fe-studio [data-fe-sample-video]");
  await until(
    "document.querySelectorAll('dialog.fe-studio [data-fe-candidate]').length===10",
  );
  const videoAnalyzes = await evaluate(
    "calls.filter(x=>x.path.endsWith('/analyze')).slice(" +
      analyzesBeforeVideo +
      ")",
  );
  assert.equal(
    videoAnalyzes.length,
    5,
    "Five-second selected range analyzes exactly five video frames",
  );
  assert.ok(
    videoAnalyzes.every(
      (x) =>
        Object.keys(x.body).every((k) => k === "image_base64" || k === "roi") &&
        typeof x.body.image_base64 === "string",
    ),
    "Video sends sampled JPEG frames, never the full video file",
  );
  const videoLabels = await evaluate(
    "Array.from(document.querySelectorAll('dialog.fe-studio [data-fe-candidate] span')).map(e=>e.textContent)",
  );
  for (const stamp of ["1.0s", "2.0s", "3.0s", "4.0s", "5.0s"])
    assert.ok(
      videoLabels.some((label) => label.includes(stamp)),
      "Video review includes sampled timestamp " + stamp,
    );
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('dialog.fe-studio [data-fe-candidate]')).some(b=>b.getAttribute('aria-pressed')==='true')",
    ),
    false,
    "Video samples remain unselected until user review",
  );
  assert.equal(
    await evaluate(
      "calls.filter(x=>x.path.endsWith('/enroll-reviewed')).length",
    ),
    savesBeforeVideo,
    "Video inspection never saves before explicit confirmation",
  );
  await click("dialog.fe-studio [data-fe-close]");
  await until("!document.querySelector('dialog.fe-studio')");
  await click("#face-gallery-tools [data-gid=g1]");
  await until(
    "document.querySelector('#face-gallery-tools [data-detail]').innerText.includes('Ada')",
  );
  await click("[data-enroll-open]");
  await until("!!document.querySelector('dialog.fe-studio[open]')");
  await evaluate(
    "(()=>{const camera=document.querySelector('[data-fe-camera]');camera.value='cam-1';camera.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  await until("document.querySelector('[data-fe-inspect]').disabled===false");
  await evaluate(`(() => {
    const stage=document.querySelector('[data-fe-stage]'),r=stage.getBoundingClientRect();
    stage.setPointerCapture=()=>{};stage.hasPointerCapture=()=>false;
    stage.dispatchEvent(new PointerEvent('pointerdown',{pointerId:3,button:0,clientX:r.left+r.width*.2,clientY:r.top+r.height*.2,bubbles:true}));
    stage.dispatchEvent(new PointerEvent('pointermove',{pointerId:3,button:0,clientX:r.left+r.width*.8,clientY:r.top+r.height*.8,bubbles:true}));
    stage.dispatchEvent(new PointerEvent('pointerup',{pointerId:3,button:0,clientX:r.left+r.width*.8,clientY:r.top+r.height*.8,bubbles:true}));
  })()`);
  assert.equal(
    await evaluate("document.querySelector('[data-fe-live]').textContent"),
    "Resume live",
    "Starting a focus drag freezes live preview for stable targeting",
  );
  await click("[data-fe-inspect]");
  await until("!!document.querySelector('[data-fe-candidate]')");
  const frozenRequest = await evaluate(
    "calls.filter(c=>c.path.endsWith('/analyze')).at(-1).body",
  );
  assert.equal(typeof frozenRequest.image_base64, "string");
  assert.equal(
    "camera_id" in frozenRequest,
    false,
    "Inspect uses the frozen displayed frame instead of taking a different camera frame",
  );
  await click("[data-fe-close]");
  await until("!document.querySelector('dialog.fe-studio')");
  for (const selector of ["[data-rg]", "[data-ri]", "[data-xg]", "[data-xi]"]) {
    const before = await evaluate("calls.length");
    await click("#face-gallery-tools " + selector);
    await until("!!document.querySelector('.dt-dialog[open]')");
    assert.equal(
      await evaluate(
        "document.querySelector('.dt-dialog [value=confirm]').classList.contains('dt-button')",
      ),
      true,
    );
    await click(".dt-dialog-close");
    await until("!document.querySelector('.dt-dialog')");
    assert.equal(
      await evaluate("calls.length"),
      before,
      "Cancel rename/delete must not call an API",
    );
  }
  const readsBeforeRename = await evaluate(
    "calls.filter(x=>x.path==='/api/faces/galleries'&&x.method==='GET').length",
  );
  await click("#face-gallery-tools [data-ri]");
  await until("!!document.querySelector('.dt-dialog[open]')");
  await evaluate(
    "(()=>{const i=document.querySelector('.dt-dialog input');i.value='Renamed Ada';i.focus()})()",
  );
  await command(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    },
    sid,
  );
  await command(
    "Input.dispatchKeyEvent",
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    sid,
  );
  await until("!document.querySelector('.dt-dialog')");
  assert.equal(
    await evaluate(
      "calls.some(x=>x.path.endsWith('/identities/i1/rename') && x.body?.name==='Renamed Ada')",
    ),
    true,
    "Enter submits the rename rather than canceling it",
  );
  await until(
    `calls.filter(x=>x.path==='/api/faces/galleries'&&x.method==='GET').length>${readsBeforeRename}`,
  );
  await until("!!document.querySelector('#face-gallery-tools [data-xs=s1]')");
  await click("#face-gallery-tools [data-xs=s1]");
  await until("!!document.querySelector('.dt-dialog[open]')");
  const readsBeforeSampleRemove = await evaluate(
    "calls.filter(x=>x.path==='/api/faces/galleries'&&x.method==='GET').length",
  );
  await click(".dt-dialog [value=confirm]");
  await until("!document.querySelector('.dt-dialog')");
  await until(
    `calls.filter(x=>x.path==='/api/faces/galleries'&&x.method==='GET').length>${readsBeforeSampleRemove}`,
  );
  assert.match(
    await evaluate("document.querySelector('[data-gid=g1]').innerText"),
    /1 identities.*0 samples/,
    "Removing a sample refreshes gallery counts",
  );
  await click("#face-gallery-tools [data-xi=i1]");
  await until("!!document.querySelector('.dt-dialog[open]')");
  const readsBeforeIdentityRemove = await evaluate(
    "calls.filter(x=>x.path==='/api/faces/galleries'&&x.method==='GET').length",
  );
  await click(".dt-dialog [value=confirm]");
  await until("!document.querySelector('.dt-dialog')");
  await until(
    `calls.filter(x=>x.path==='/api/faces/galleries'&&x.method==='GET').length>${readsBeforeIdentityRemove}`,
  );
  assert.match(
    await evaluate("document.querySelector('[data-gid=g1]').innerText"),
    /0 identities.*0 samples/,
    "Removing an identity refreshes gallery counts",
  );
  await click("#onvif-camera-tools [data-discover]");
  await until("document.querySelector('[data-devices]').options.length>1");
  await evaluate(
    "(()=>{document.querySelector('[data-devices]').value='http://192.168.1.8/onvif/device_service';document.querySelector('[data-devices]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-user]').value='operator';document.querySelector('[data-pass]').value='secret';document.querySelector('[data-connect]').click()})()",
  );
  await until("!!document.querySelector('.dt-connected [data-move]')");
  assert.equal(
    await evaluate(
      "document.querySelector('.dt-ptz [aria-label=\"Zoom in\"]').disabled",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.dt-ptz [aria-label=\"Stop\"]').disabled",
    ),
    false,
  );
  await click(".dt-connected [data-add]");
  await click('.dt-ptz [aria-label="Tilt up"]');
  await until("calls.some(x=>x.path==='/api/onvif/move')");
  assert.equal(
    await evaluate("document.querySelector('[data-pass]').value"),
    "",
  );
  const move = await evaluate("calls.find(x=>x.path==='/api/onvif/move').body");
  assert.equal(move.duration_ms, 250);
  assert.equal(move.tilt, 1);
  await click('.dt-ptz [aria-label="Stop"]');
  assert.equal(
    await evaluate("calls.some(x=>x.path==='/api/onvif/stop')"),
    true,
  );
  await click("#onvif-camera-tools [data-refresh-sessions]");
  await until("!!document.querySelector('[data-sessions] option[value=s-1]')");
  await evaluate(
    "(()=>{const s=document.querySelector('[data-sessions]');s.value='s-1';s.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-pass]').value"),
    "",
  );
  for (const v of [
    { width: 1280, height: 800 },
    { width: 390, height: 700, mobile: true },
    { width: 1100, height: 450 },
  ]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { ...v, deviceScaleFactor: 1, mobile: v.mobile || false },
      sid,
    );
    for (const theme of ["light", "dark"]) {
      await evaluate(
        "document.documentElement.dataset.theme=" + JSON.stringify(theme),
      );
      const box = await evaluate(
        "(()=>{const r=document.querySelector('#onvif-camera-tools .dt-card').getBoundingClientRect();return {width:document.documentElement.scrollWidth,innerWidth,left:r.left,right:r.right}})()",
      );
      assert.ok(
        box.width <= v.width,
        JSON.stringify(v) + "/" + theme + " overflow " + JSON.stringify(box),
      );
      assert.ok(
        box.left >= 0 && box.right <= v.width + 1,
        JSON.stringify(v) + "/" + theme + " panel outside viewport",
      );
      await until(
        "!document.querySelector('dialog')&&!document.querySelector('#face-gallery-tools')._creatingGallery&&!document.querySelector('#face-gallery-tools [data-create]').disabled",
      );
      await click("#face-gallery-tools [data-create]");
      await until("!!document.querySelector('.dt-dialog[open]')");
      const themeAudit = await evaluate(`(() => {
        const dialog=document.querySelector('.dt-dialog'), select=dialog.querySelector('select'), input=dialog.querySelector('input');
        const close=dialog.querySelector('.dt-dialog-close'), b=close.getBoundingClientRect(), i=close.querySelector('svg').getBoundingClientRect();
        return {appearance:getComputedStyle(select).appearance, background:getComputedStyle(input).backgroundColor,
          closeCentered:Math.abs(b.x+b.width/2-i.x-i.width/2)<1 && Math.abs(b.y+b.height/2-i.y-i.height/2)<1};
      })()`);
      assert.equal(themeAudit.appearance, "none");
      assert.equal(
        themeAudit.background,
        theme === "light" ? "rgb(255, 254, 250)" : "rgb(30, 28, 27)",
      );
      assert.equal(themeAudit.closeCentered, true);
      const fits = await evaluate(
        "(()=>{let d=document.querySelector('.dt-dialog'),r=d.getBoundingClientRect();let ok=r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;d.close();return ok})()",
      );
      assert.equal(
        fits,
        true,
        JSON.stringify(v) + "/" + theme + " gallery dialog overflow",
      );
      await until("!document.querySelector('.dt-dialog')");
      await evaluate(
        "(()=>{document.querySelector('[data-enroll-open]').click()})()",
      );
      await until("!!document.querySelector('dialog.fe-studio[open]')");
      const fileTheme = await evaluate(`(() => {
        const input = document.querySelector('dialog.fe-studio [data-fe-file]');
        return {background:getComputedStyle(input,'::file-selector-button').backgroundColor,
          color:getComputedStyle(input,'::file-selector-button').color};
      })()`);
      assert.equal(fileTheme.background, "rgb(190, 26, 26)");
      assert.equal(fileTheme.color, "rgb(255, 255, 255)");
      const studioFits = await evaluate(
        "(()=>{const d=document.querySelector('dialog.fe-studio'),r=d.getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}})()",
      );
      assert.equal(
        studioFits.fits,
        true,
        JSON.stringify(v) + "/" + theme + " enrollment studio outside viewport",
      );
      assert.ok(
        studioFits.scrollWidth <= studioFits.clientWidth,
        JSON.stringify(v) +
          "/" +
          theme +
          " enrollment studio causes horizontal overflow",
      );
      if (theme === "light" && (v.width === 1280 || v.mobile)) {
        await delay(250);
        await mkdir(screenshotDir, { recursive: true });
        const shot = await command(
          "Page.captureScreenshot",
          { format: "png" },
          sid,
        );
        await writeFile(
          path.join(screenshotDir, v.mobile ? "mobile.png" : "desktop.png"),
          Buffer.from(shot.data, "base64"),
        );
      }
      await click("dialog.fe-studio [data-fe-close]");
      await until("!document.querySelector('dialog.fe-studio')");
    }
  }
  assert.equal(
    await evaluate(
      "calls.some(x=>x.path==='/api/cameras/cam-1/preview-frame'&&x.method==='GET')",
    ),
    true,
    "Enrollment studio previews selected camera through mocked JPEG endpoint",
  );
  assert.deepEqual(await evaluate("runtimeErrors"), []);
  await command(
    "Page.navigate",
    { url: "http://127.0.0.1:" + server.address().port + "/?showcase" },
    sid,
  );
  await until("!!document.querySelector('#onvif-camera-tools .dt-card')");
  assert.equal(
    await evaluate("calls.length"),
    0,
    "Showcase must make zero API calls",
  );
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('.dt-card button')).every(b=>b.disabled)",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "calls.some(x=>x.path.includes('/analyze')||x.path.includes('/enroll-reviewed')||x.path.startsWith('/api/cameras/'))",
    ),
    false,
    "Showcase enrollment preview and review make zero API calls",
  );
  console.log(
    "PASS: visual enrollment review, ROI, local video sampling, ONVIF controls, responsive themes, showcase zero API calls",
  );
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(150);
  assert.ok(path.basename(profile).startsWith("spyder-device-tools-browser-"));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
