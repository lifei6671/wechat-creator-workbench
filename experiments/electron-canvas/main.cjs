const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");

const hostUrl = new URL(process.env.CANVAS_PROTOTYPE_URL);
if (hostUrl.protocol !== "http:" || hostUrl.hostname !== "127.0.0.1") throw Error("Expected the local prototype server");
app.setPath("userData", process.env.CANVAS_PROTOTYPE_PROFILE);

function isWebUrl(value) {
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:";
}

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guest = contents.getType() === "webview";
  const navigation = (event, url) => {
    if (guest ? !isWebUrl(url) : new URL(url).origin !== hostUrl.origin) event.preventDefault();
  };
  contents.on("will-navigate", navigation);
  contents.on("will-redirect", navigation);
  contents.on("will-attach-webview", (event, preferences, params) => {
    if (guest || !isWebUrl(params.src)) { event.preventDefault(); return; }
    delete preferences.preload;
    Object.assign(preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false });
  });
});

app.whenReady().then(async () => {
  const remote = session.fromPartition("canvas-prototype");
  remote.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  remote.setPermissionCheckHandler(() => false);
  remote.on("will-download", event => event.preventDefault());
  const window = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 650,
    title: "网页画布验证原型", autoHideMenuBar: true,
    alwaysOnTop: process.argv.includes("--verify"),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: true },
  });
  await window.loadURL(hostUrl.href);
  if (process.argv.includes("--verify")) {
    try {
      const { verify } = require("./verify.cjs");
      const scale = await window.webContents.executeJavaScript("devicePixelRatio");
      await verify(window, path.join(__dirname, "artifacts", `scale-${scale}`));
      app.exit(0);
    } catch (error) {
      console.error(error);
      window.destroy();
      app.exit(1);
    }
  }
}).catch(error => { console.error(error); app.exit(1); });
app.on("window-all-closed", () => app.quit());
