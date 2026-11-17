import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, platform, release, cpus } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { cases, documentFixture } from "./documents.mjs";

const [binary, destination, roundsText = "5", names = "L1-100k,L3-5000,L4,L5"] = process.argv.slice(2);
const rounds = Number(roundsText);
const namesList = names.split(",");
if (platform() !== "win32" || !binary || basename(binary) !== "wechat-creator-workbench-performance.exe"
  || !destination || !Number.isInteger(rounds) || rounds < 1
  || namesList.some(name => name !== "tabs" && name !== "outputs" && !(name in cases))) {
  throw new Error("node fixtures/performance/run.mjs <性能测试 exe> <结果目录> [轮数] [用逗号分隔的样本]");
}

const directory = resolve(destination);
await mkdir(directory, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "wechat-workbench-perf-"));
const portProbe = createServer();
await new Promise((done, reject) => portProbe.once("error", reject).listen(0, "127.0.0.1", done));
const { port } = portProbe.address();
await new Promise((done, reject) => portProbe.close(error => error ? reject(error) : done()));
const executable = resolve(binary);
const app = spawn(executable, [], { cwd: dirname(executable), stdio: "ignore", env: {
  ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
} });

async function workingSet() {
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$view = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object {
      $_.CommandLine -and $_.CommandLine.IndexOf($env:WORKBENCH_PERF_PROFILE, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    [ordered]@{app=(Get-Process -Id ${app.pid}).WorkingSet64; webview=($view | Measure-Object WorkingSetSize -Sum).Sum; webviewProcesses=$view.Count} | ConvertTo-Json -Compress`],
  { windowsHide: true, env: { ...process.env, WORKBENCH_PERF_PROFILE: profile } });
  return JSON.parse(stdout);
}

async function target() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.exitCode !== null) throw new Error(`性能测试程序已退出 (${app.exitCode})`);
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json(), () => []);
    const page = pages.find(item => item.type === "page" && item.url.includes("tauri.localhost"));
    if (page) return page;
    await delay(100);
  }
  throw new Error("WebView2 未提供可调试的工作台页面");
}

async function replay(entryId, fixtureName) {
  const perf = window.__workbenchEditorPerformance;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  const frame = () => new Promise(requestAnimationFrame);
  const started = performance.now();
  while (!perf?.editors.has(entryId)) {
    if (performance.now() - started > 30_000) throw new Error("等待编辑器打开超时");
    await sleep(20);
  }
  await frame();
  const opened = { ...perf.metrics };
  const { view, handle } = perf.editors.get(entryId);
  const original = view.state.doc;
  let nodes = 1;
  let cells = 0;
  original.descendants(node => { nodes++; if (node.type.spec.tableRole?.endsWith("cell")) cells++; });
  const shape = { nodes, blocks: original.childCount, cells };
  const longTasks = [];
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
  observer.observe({ entryTypes: ["longtask"] });
  const selection = (from, to = from) => view.state.selection.constructor.create(view.state.doc, from, to);
  async function timed(count, action) {
    const values = [];
    const dispatch = [];
    for (let i = 0; i < count; i++) {
      await frame();
      const start = performance.now();
      await action(i);
      dispatch.push(performance.now() - start);
      await frame();
      values.push(performance.now() - start);
    }
    return { nextFrameMs: values, operationMs: dispatch };
  }
  handle.focus();
  view.dispatch(view.state.tr.setSelection(selection(1)));
  perf.reset();
  const input = await timed(200, () => view.dispatch(view.state.tr.insertText("稿")));
  const inputMetrics = structuredClone(perf.metrics);
  const saveStarted = performance.now();
  view.dom.blur();
  const expectedPrefix = "稿".repeat(200);
  for (;;) {
    const saved = await invoke("get_entry", { id: entryId });
    if (saved.contentMd.startsWith(expectedPrefix)) break;
    if (performance.now() - saveStarted > 10_000) throw new Error("连续输入后的正文未保存");
    await sleep(25);
  }
  const save = { elapsedMs: performance.now() - saveStarted, metrics: structuredClone(perf.metrics) };

  perf.reset();
  handle.focus();
  const cursor = await timed(100, index => view.dispatch(view.state.tr.setSelection(selection(1 + index))));
  const targetMetrics = [];
  const ai = await timed(10, index => {
    const { doc } = view.state;
    let end = doc.firstChild.nodeSize - 1;
    if (fixtureName === "L6") {
      const blocks = [1, 20, 200][index % 3];
      end = doc.childBefore(doc.content.size).offset;
      if (blocks < doc.childCount) {
        end = 0;
        for (let i = 0; i < blocks; i++) end += doc.child(i).nodeSize;
        end--;
      }
    }
    view.dispatch(view.state.tr.setSelection(selection(1, end)));
    const capture = performance.now();
    const target = handle.captureContext("selection");
    const captured = performance.now();
    if (!target || !handle.replaceTarget(target, "修订" + target.original)) throw new Error("AI 模拟替换未提交");
    const replaced = performance.now();
    targetMetrics.push({ captureMs: captured - capture, replaceMs: replaced - captured });
    handle.command("undo");
  });
  const deletion = await timed(30, () => view.dispatch(view.state.tr.delete(0, view.state.doc.firstChild.nodeSize)));
  const paste = await timed(10, async () => {
    const before = view.state.doc;
    handle.clipboard("paste", { read: async () => "粘贴一段测试内容", write: async () => {}, onError: error => { throw error; } });
    for (let i = 0; view.state.doc === before; i++) {
      if (i === 50) throw new Error("粘贴未提交");
      await sleep(5);
    }
  });
  observer.disconnect();
  return { shape, opened, input, inputMetrics, save, cursor, deletion, paste, ai, targetMetrics, longTasks,
    domElements: document.querySelectorAll("*").length, viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
    browser: navigator.userAgent };
}

const results = [];
let socket;
try {
  const page = await target();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.done(message.result);
  };
  socket.onclose = () => {
    for (const request of pending.values()) request.reject(new Error("WebView2 调试连接已关闭"));
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence;
    pending.set(id, { done, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 120_000 });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function waitForEditorPerformance() {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate("Boolean(window.__workbenchEditorPerformance)")) return;
      await delay(100);
    }
    throw new Error("工作台未加载性能测试模块，请检查 VITE_EDITOR_PERF 和构建产物");
  }
  async function openFixtures(name, markdown, count = 1, existing = [], cold = existing.length === 0) {
    const ids = await evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const { workspaceId } = await invoke('library');
      const ids = ${JSON.stringify(existing)};
      while (ids.length < ${count}) {
        const entry = await invoke('create_entry', {kind:'article', fields:{title:${JSON.stringify(name)}, contentMd:${JSON.stringify(markdown)},
          status:'draft', categoryId:null, tags:[], summary:'', source:null, publishedAt:null, publishedUrl:''}})
          .catch(error => { throw new Error(typeof error === 'string' ? error : JSON.stringify(error)); });
        ids.push(entry.id);
      }
      localStorage.setItem('links-to-footnotes', ${JSON.stringify(name === "L4" ? "true" : "false")});
      localStorage.setItem('document-tabs:' + workspaceId, JSON.stringify({ids, activeId:ids[0]}));
      return ids;
    })()`);
    await send("Page.reload", { ignoreCache: cold });
    await waitForEditorPerformance();
    return ids;
  }
  async function saveResult(result) {
    results.push(result);
    await writeFile(join(directory, "results.json"), JSON.stringify({ os: release(), cpu: cpus()[0].model, results }));
  }
  async function checkOutputs() {
    const { markdown } = documentFixture("L1-10k");
    const [id] = await openFixtures("实时预览", markdown);
    const result = await evaluate(`(async () => {
      const id = ${JSON.stringify(id)};
      const perf = window.__workbenchEditorPerformance;
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const waitFor = async check => {
        const deadline = performance.now() + 20_000;
        while (!check()) {
          if (performance.now() > deadline) throw new Error('等待文稿或预览超时');
          await new Promise(done => setTimeout(done, 20));
        }
      };
      await waitFor(() => perf.editors.has(id));
      const { view, handle } = perf.editors.get(id);
      const old = await invoke('get_entry', { id });
      const prefix = '未保存末字';
      view.dispatch(view.state.tr.insertText(prefix, 1));
      const context = handle.captureContext('document')?.original;
      handle.command('selectAll');
      handle.command('selectAll');
      let clipboard = '';
      handle.clipboard('copy', {write: async value => { clipboard = value; }, onError: error => { throw error; }});
      const stored = await invoke('get_entry', { id });
      if (stored.version !== old.version || !context?.startsWith(prefix) || !clipboard.startsWith(prefix)) {
        throw new Error('全文读取未取得同一份未保存正文');
      }
      Array.from(document.querySelectorAll('.status-bar button')).find(button => button.textContent === '预览排版')?.click();
      await waitFor(() => document.querySelector('.preview-stack .markdown-preview')?.shadowRoot
        ?.querySelector('article')?.textContent.includes(prefix));
      return { cachedVersion: old.version, copy: true, preview: true, aiDocumentContext: true };
    })()`);
    await saveResult({ outputs: result });
    console.log("未保存正文的全选复制、预览与 AI 全文读取一致");
  }
  async function measureTabs() {
    const { markdown, ...fixture } = documentFixture("L1-100k");
    let ids = [];
    for (const count of [1, 5, 10]) {
      ids = await openFixtures("长文标签", markdown, count, ids);
      const switchFrameMs = await evaluate(`(async () => {
        const ids = ${JSON.stringify(ids)};
        const perf = window.__workbenchEditorPerformance;
        const frame = () => new Promise(requestAnimationFrame);
        const deadline = performance.now() + 30_000;
        while (perf.editors.size !== ids.length) {
          if (performance.now() > deadline) throw new Error('长文标签加载超时');
          await new Promise(done => setTimeout(done, 50));
        }
        const samples = [];
        if (ids.length === 1) return samples;
        for (let i = 1; i <= ${rounds * 10}; i++) {
          await frame();
          const start = performance.now();
          const tab = document.getElementById('tab-' + ids[i % ids.length]);
          tab.click();
          while (tab.getAttribute('aria-selected') !== 'true') await frame();
          await frame();
          samples.push(performance.now() - start);
        }
        return samples;
      })()`);
      const before = { workingSet: await workingSet(), heap: await send("Runtime.getHeapUsage"),
        elements: await evaluate("document.querySelectorAll('*').length") };
      await evaluate(`(async () => {
        const perf = window.__workbenchEditorPerformance;
        const deadline = performance.now() + 15_000;
        while (perf.editors.size) {
          const button = document.querySelector('.tab-close');
          button?.click();
          if (performance.now() > deadline) throw new Error('长文标签关闭超时');
          await new Promise(done => setTimeout(done, 50));
        }
      })()`);
      await send("HeapProfiler.collectGarbage");
      const after = { workingSet: await workingSet(), heap: await send("Runtime.getHeapUsage"),
        elements: await evaluate("document.querySelectorAll('*').length") };
      await saveResult({ fixture, tabs: count, switchFrameMs, before, after });
      console.log(`${count} 个长文标签，已记录切换和关闭后的内存`);
    }
    const [cycleId] = await openFixtures("长文回收", "回收测试\n\n```mermaid\ngraph TD; A-->B;\n```\n\n" + markdown);
    const recovery = await evaluate(`(async () => {
      const id = ${JSON.stringify(cycleId)};
      const perf = window.__workbenchEditorPerformance;
      const invoke = window.__TAURI_INTERNALS__.invoke;
      async function waitFor(check) {
        const deadline = performance.now() + 15_000;
        while (!check()) {
          if (performance.now() > deadline) throw new Error('等待标签恢复或关闭超时');
          await new Promise(done => setTimeout(done, 20));
        }
      }
      const button = () => document.querySelector('.tab-close');
      await waitFor(() => perf.editors.has(id) && button());
      button().click();
      await waitFor(() => !perf.editors.has(id));
      const create = URL.createObjectURL;
      const revoke = URL.revokeObjectURL;
      const activeUrls = new Set();
      let created = 0;
      let remaining = 0;
      URL.createObjectURL = blob => {
        const url = create.call(URL, blob);
        activeUrls.add(url);
        created++;
        return url;
      };
      URL.revokeObjectURL = url => { activeUrls.delete(url); return revoke.call(URL, url); };
      try {
        const original = await invoke('get_entry', { id });
        for (let i = 1; i <= ${rounds * 10}; i++) {
          await waitFor(() => document.getElementById('entry-row-' + id));
          document.getElementById('entry-row-' + id).click();
          await waitFor(() => perf.editors.has(id) && button());
          const { view } = perf.editors.get(id);
          await waitFor(() => view.dom.querySelector('img[src^="blob:"]'));
          view.dispatch(view.state.tr.insertText('稿', 1));
          button().click();
          await waitFor(() => !perf.editors.has(id));
          remaining = Math.max(remaining, activeUrls.size);
          const saved = await invoke('get_entry', { id });
          if (saved.version !== original.version + i || !saved.contentMd.startsWith('稿'.repeat(i) + '回收测试')) {
            throw new Error('标签关闭后数据库版本或正文不一致');
          }
        }
        return { cycles: ${rounds * 10}, created, maxUrlsAfterClose: remaining, liveEditors: perf.editors.size };
      } finally {
        URL.createObjectURL = create;
        URL.revokeObjectURL = revoke;
      }
    })()`);
    await send("HeapProfiler.collectGarbage");
    await saveResult({ fixture, recovery, heap: await send("Runtime.getHeapUsage"), workingSet: await workingSet() });
    console.log(`${recovery.cycles} 次长文保存、关闭与重开，正文与版本一致`);
  }

  await send("Page.bringToFront");
  await waitForEditorPerformance();
  for (const name of namesList) {
    if (name === "tabs") { await measureTabs(); continue; }
    if (name === "outputs") { await checkOutputs(); continue; }
    const { markdown, ...fixture } = documentFixture(name);
    for (let round = 1; round <= rounds; round++) {
      const [entryId] = await openFixtures(name, markdown, 1, [], round === 1);
      const stats = await evaluate(`(${replay.toString()})(${JSON.stringify(entryId)}, ${JSON.stringify(name)})`);
      await saveResult({ fixture, round, ...stats, heap: await send("Runtime.getHeapUsage") });
      console.log(`${name} 第 ${round} 轮，200 次输入期间全文序列化 ${stats.inputMetrics["markdown.serialize"]?.count ?? 0} 次`);
      if (round === 1) {
        const screenshot = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(join(directory, `${name}.png`), Buffer.from(screenshot.data, "base64"));
      }
    }
  }
} finally {
  socket?.close();
  if (app.exitCode === null) {
    const exited = once(app, "exit");
    if (app.kill()) await exited;
  }
}
