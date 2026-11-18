const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.verify = async function verify(window, artifacts) {
  assert.equal(process.platform, "win32", "The native display/input checks currently support Windows");
  await fs.mkdir(artifacts, { recursive: true });
  const host = code => window.webContents.executeJavaScript(code);
  const guest = code => host(`document.querySelector('webview').executeJavaScript(${JSON.stringify(code)})`);
  async function until(check, message) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await pause(40);
    }
    throw Error(message);
  }
  await until(() => host("Boolean(window.canvasPrototype && document.querySelector('webview')?.dataset.ready==='true')"), "Prototype did not mount");
  await until(() => guest("Boolean(window.probe)"), "Fixture did not load");
  await guest("new Promise(done=>{scrollTo(0,320);requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))})");
  const metrics = "({birth:probe.birth,width:innerWidth,height:innerHeight,paragraph:document.querySelector('#paragraph').getBoundingClientRect().height,scroll:scrollY,frames:probe.frames,resizes:probe.resizes,node:typeof require,process:typeof process})";
  const initial = await guest(metrics);
  assert.notEqual(await guest("location.origin"), await host("location.origin"), "Fixture must be cross-origin");
  const guestId = await host("document.querySelector('webview').getWebContentsId()");
  assert.equal(initial.node, "undefined");
  assert.equal(initial.process, "undefined");
  assert.equal(await host("typeof require"), "undefined");
  const frame = () => host(`(()=>{
    const view=document.querySelector('webview'),r=view.getBoundingClientRect(),area=document.querySelector('.prototype-canvas').getBoundingClientRect();
    const zoom=new DOMMatrix(getComputedStyle(view.closest('.react-flow__viewport')).transform).a;
    return {x:r.x,y:r.y,width:r.width,height:r.height,layoutWidth:parseFloat(getComputedStyle(view).width),layoutHeight:parseFloat(getComputedStyle(view).height),zoom,
      area:{x:area.x,y:area.y,width:area.width,height:area.height},dpr:devicePixelRatio,
      point:{x:r.right-50*zoom,y:r.bottom-50*zoom}};
  })()`);
  function checkLayout(current) {
    assert.equal(current.birth, initial.birth, "Guest was reloaded");
    assert.equal(current.width, initial.width, "Guest viewport width reflowed");
    assert.equal(current.height, initial.height, "Guest viewport height changed");
    assert.equal(current.paragraph, initial.paragraph, "Article paragraph rewrapped");
    assert.equal(current.scroll, initial.scroll, "Canvas transform changed the page scroll");
    assert.ok(current.resizes.slice(initial.resizes.length).every(resize => resize.width === initial.width && resize.height === initial.height), "Guest transiently resized while transforming");
  }
  const firstFrame = await frame();
  await fs.writeFile(path.join(artifacts, "initial.png"), (await window.webContents.capturePage()).toPNG());
  const initialViewport = await host("canvasPrototype.getViewport()");
  const anchor = { x: firstFrame.area.width * 0.55, y: firstFrame.area.height * 0.55 };
  const world = { x: (firstFrame.point.x - firstFrame.area.x - initialViewport.x) / initialViewport.zoom,
    y: (firstFrame.point.y - firstFrame.area.y - initialViewport.y) / initialViewport.zoom };
  const targetFor = zoom => ({ x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom, zoom });
  await host(`canvasPrototype.setViewport(${JSON.stringify(targetFor(firstFrame.zoom))})`);
  await pause(100);
  const paintPoint = { x: firstFrame.area.x + anchor.x, y: firstFrame.area.y + anchor.y };
  const hwnd = window.getNativeWindowHandle().readBigUInt64LE().toString();
  const probeFile = path.join(__dirname, "display-probe.ps1");
  const probeArguments = point => ["-NoProfile", "-File", probeFile, "-WindowHandle", hwnd, "-PixelScale", String(firstFrame.dpr), "-ClientX", String(point.x), "-ClientY", String(point.y)];
  const screen = spawn("pwsh.exe", [...probeArguments(paintPoint), "-Action", "sample"], { windowsHide: true });
  const screenExit = once(screen, "exit");
  window.once("closed", () => screen.kill());
  let screenData = "", screenError = "";
  screen.stdout.on("data", data => { screenData += data; });
  screen.stderr.on("data", data => { screenError += data; });
  await until(() => Promise.resolve(screenData.includes("READY")), `Desktop sampler did not start: ${screenError}`);
  const samples = [];
  const layouts = [];
  const inFlightLayouts = [];
  const pulseColors = new Set();
  for (let phase = 0; phase < 30; phase++) {
    const zoom = phase % 2 ? 0.55 : 1.3;
    const target = targetFor(zoom);
    await host(`void canvasPrototype.setViewport(${JSON.stringify(target)},{duration:250,interpolate:'linear',ease:t=>1-(1-t)**3});true`);
    const end = Date.now() + 300;
    while (Date.now() < end) {
      const geometry = await frame();
      const point = paintPoint;
      assert.ok(Math.abs(geometry.point.x - point.x) < 0.01 && Math.abs(geometry.point.y - point.y) < 0.01, "Zoom paint target moved away from its anchor");
      const capture = await window.webContents.capturePage({ x: Math.round(point.x - 2), y: Math.round(point.y - 2), width: 4, height: 4 });
      const bitmap = capture.toBitmap({ scaleFactor: 1 });
      let amber = 0, white = 0;
      for (let pixel = 0; pixel < bitmap.length; pixel += 4) {
        const [blue, green, red] = bitmap.subarray(pixel, pixel + 3);
        if (red > 245 && green > 235 && blue > 170 && blue < 215) amber++;
        if (red > 245 && green > 245 && blue > 245) white++;
      }
      assert.ok(Math.abs(geometry.width - geometry.layoutWidth * geometry.zoom) < 0.01, `Guest did not share the card's transform: ${JSON.stringify(geometry)}`);
      samples.push({ zoom: geometry.zoom, amber, white, pixels: bitmap.length / 4 });
      if (samples.length % 4 === 0) {
        const current = await guest(metrics);
        checkLayout(current);
        inFlightLayouts.push(current);
        const pulse = await window.webContents.capturePage({ x: Math.round(point.x), y: Math.round(point.y - 40 * geometry.zoom), width: 1, height: 1 });
        const [blue, green, red] = pulse.toBitmap({ scaleFactor: 1 });
        if (blue > 200 && red < 60) pulseColors.add("blue");
        if (green > 140 && red > 30 && blue < 140) pulseColors.add("green");
      }
    }
    const current = await guest(metrics);
    checkLayout(current);
    layouts.push(current);
  }
  assert.ok(samples.length > 60, "Too few composited-frame samples");
  assert.ok(new Set(samples.map(sample => sample.zoom.toFixed(3))).size > 20, "Intermediate zoom frames were not sampled");
  assert.ok(samples.every(sample => sample.amber === sample.pixels), "A composited frame lost the webpage's paint target");
  assert.equal(pulseColors.size, 2, "The live guest's changing colors were not composited during zoom");
  const [screenCode] = await screenExit;
  assert.equal(screenCode, 0, screenError);
  const desktop = JSON.parse(screenData.slice(screenData.indexOf("\n") + 1));
  assert.ok(desktop.length > 200, "Too few actual display samples");
  assert.ok(window.isAlwaysOnTop(), "The display test window must stay unobstructed");
  assert.ok(desktop.every(sample => sample.r > 245 && sample.g > 235 && sample.b > 170 && sample.b < 215), "Actual desktop lost the live webpage paint target");
  assert.ok(layouts.every((layout, index) => layout.frames > (index ? layouts[index - 1].frames : initial.frames)), "The live page stopped updating during zoom");
  for (const view of [
    { x: 0, y: 0, zoom: 0.1 }, { x: -600, y: -400, zoom: 3 },
    { x: -2000, y: -2000, zoom: 1 }, { x: 80, y: 50, zoom: 0.8 },
  ]) {
    await host(`canvasPrototype.setViewport(${JSON.stringify(view)})`);
    await pause(100);
    checkLayout(await guest(metrics));
  }
  const area = firstFrame.area;
  for (const [edge, view] of [
    ["left", { x: -300, y: 50, zoom: 1 }], ["top", { x: 100, y: -300, zoom: 1 }],
    ["right", { x: area.width - 260, y: 50, zoom: 1 }], ["bottom", { x: 100, y: area.height - 260, zoom: 1 }],
  ]) {
    await host(`canvasPrototype.setViewport(${JSON.stringify(view)})`);
    await pause(100);
    checkLayout(await guest(metrics));
    const geometry = await frame();
    const x = (Math.max(area.x, geometry.x) + Math.min(area.x + area.width, geometry.x + geometry.width)) / 2;
    const y = (Math.max(area.y, geometry.y) + Math.min(area.y + area.height, geometry.y + geometry.height)) / 2;
    const outside = edge === "left" ? { x: area.x - 4, y } : edge === "right" ? { x: area.x + area.width + 4, y }
      : edge === "top" ? { x, y: area.y - 4 } : { x, y: area.y + area.height + 4 };
    const pixel = (await window.webContents.capturePage({ x: Math.round(outside.x), y: Math.round(outside.y), width: 1, height: 1 })).toBitmap({ scaleFactor: 1 });
    const [blue, green, red] = pixel;
    assert.ok(!(red > 245 && green > 235 && blue > 170 && blue < 215), `Guest painted beyond the ${edge} edge`);
    const inside = edge === "left" ? { x: area.x + 4, y } : edge === "right" ? { x: area.x + area.width - 12, y }
      : edge === "top" ? { x, y: area.y + 4 } : { x, y: area.y + area.height - 12 };
    const visible = (await window.webContents.capturePage({ x: Math.round(inside.x), y: Math.round(inside.y), width: 8, height: 8 })).toBitmap({ scaleFactor: 1 });
    let painted = false;
    for (let index = 0; index < visible.length; index += 4) {
      if (visible[index + 2] > 245 && visible[index + 1] > 235 && visible[index] > 170 && visible[index] < 215) painted = true;
    }
    assert.ok(painted, `Guest disappeared inside the ${edge} edge`);
    await fs.writeFile(path.join(artifacts, `clipped-${edge}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await host("canvasPrototype.setViewport({x:80,y:50,zoom:0.8});canvasPrototype.setInteractive(true)");
  await pause(100);
  window.focus();
  window.webContents.focus();
  const bounds = await frame();
  const beforeScroll = await guest("scrollY");
  const mouse = { x: Math.round(bounds.x + 160 * bounds.zoom), y: Math.round(bounds.y + 160 * bounds.zoom) };
  await promisify(execFile)("pwsh.exe", [...probeArguments(mouse), "-Action", "wheel"], { windowsHide: true });
  await until(async () => await guest("scrollY") !== beforeScroll, "Native wheel did not scroll the live guest");
  let previousScroll, settled = 0;
  await until(async () => {
    const current = await guest("scrollY");
    settled = current === previousScroll ? settled + 1 : 0;
    previousScroll = current;
    return settled >= 4;
  }, "Native scrolling did not settle");
  await guest("new Promise(done=>{scrollTo(0,0);requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))})");
  const link = await guest("(()=>{const r=document.querySelector('#next').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  const clickBounds = await frame();
  const hit = { x: Math.round(clickBounds.x + link.x * clickBounds.zoom), y: Math.round(clickBounds.y + link.y * clickBounds.zoom) };
  await promisify(execFile)("pwsh.exe", [...probeArguments(hit), "-Action", "click"], { windowsHide: true });
  await until(() => guest("location.pathname.endsWith('/next')"), "Native click did not navigate the guest");
  assert.equal(await host("document.querySelector('webview').getWebContentsId()"), guestId);
  assert.equal(await host("document.querySelectorAll('img,canvas').length"), 0, "Prototype used a raster stand-in");
  await fs.writeFile(path.join(artifacts, "final.png"), (await window.webContents.capturePage()).toPNG());
  const external = await host(`new Promise(resolve=>{
    const view=document.querySelector('webview');
    const timer=setTimeout(()=>{view.stop();resolve({status:'unverified',reason:'Network navigation timed out'})},12000);
    view.loadURL('https://example.com/').then(()=>{clearTimeout(timer);resolve({status:'loaded'})},error=>{clearTimeout(timer);resolve({status:'unverified',reason:error.message})});
  })`);
  if (external.status === "loaded") {
    external.page = await guest("({url:location.href,title:document.title,width:innerWidth,height:innerHeight})");
    assert.equal(external.page.title, "Example Domain");
    for (const zoom of [0.1, 0.55, 1.3, 3]) {
      await host(`canvasPrototype.setViewport({x:80,y:50,zoom:${zoom}})`);
      assert.equal(await guest("innerWidth"), external.page.width, "External page reflowed with canvas zoom");
    }
    await fs.writeFile(path.join(artifacts, "external.png"), (await window.webContents.capturePage()).toPNG());
    external.status = "passed";
  }
  const result = { verifiedAt: new Date().toISOString(), versions: process.versions, dpr: firstFrame.dpr,
    zoomPhases: 30, sampledFrames: samples.length, intermediateScales: new Set(samples.map(sample => sample.zoom.toFixed(3))).size,
    blankFrames: samples.filter(sample => sample.white > 0).length, initial, lastLayout: layouts.at(-1),
    inFlightLayoutSamples: inFlightLayouts.length, desktopSamples: desktop.length, desktopForegroundSamples: desktop.filter(sample => sample.active).length,
    desktopTopmost: window.isAlwaysOnTop(), desktopBlankSamples: 0, livePulseColors: [...pulseColors],
    fullZoomRange: [0.1, 3], clipping: "all four edges and fully offscreen", input: "Windows SendInput at transformed card coordinates", external, samples };
  await fs.writeFile(path.join(artifacts, "results.json"), JSON.stringify(result, null, 2));
  console.log("Electron canvas verification PASS", JSON.stringify({ ...result, versions: { electron: process.versions.electron, chrome: process.versions.chrome }, samples: undefined }));
};
