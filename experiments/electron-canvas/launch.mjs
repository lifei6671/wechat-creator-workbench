import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createServer } from "vite";
import electron from "electron";
import { fixture } from "./fixture.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const verify = process.argv.includes("--verify");
const fixtureServer = createHttpServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
  response.end(fixture);
}).listen(0, "127.0.0.1");
await once(fixtureServer, "listening");
const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture`;
const server = await createServer({
  root, configFile: false, clearScreen: false,
  define: { __FIXTURE_URL__: JSON.stringify(fixtureUrl) },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root, fileURLToPath(new URL("../../node_modules", import.meta.url))] } },
});
await server.listen();
const url = server.resolvedUrls.local[0];
const profile = await mkdtemp(join(tmpdir(), "workbench-electron-canvas-"));
const scale = process.argv.find(argument => argument.startsWith("--scale="))?.slice(8);
if (scale && !["1", "1.5"].includes(scale)) throw Error("Use --scale=1 or --scale=1.5");
const child = spawn(electron, [...(scale ? [`--force-device-scale-factor=${scale}`] : []), join(root, "main.cjs"), ...(verify ? ["--verify"] : [])], {
  cwd: root, stdio: "inherit", env: { ...process.env, CANVAS_PROTOTYPE_URL: url, CANVAS_PROTOTYPE_PROFILE: profile },
});
console.log(`Electron canvas prototype: ${url}`);
const shutdown = () => { child.kill(); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} finally {
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  await server.close();
  await new Promise(resolve => fixtureServer.close(resolve));
}
