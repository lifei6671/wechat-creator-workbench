import { readFileSync } from "node:fs";
import license from "rollup-plugin-license";
import type { Plugin } from "vite";

export function desktopLicenses(): Plugin[] {
  const notices = ["NOTICE.md", "third-party-ai.txt", "packages/wechat-renderer/SOURCES.md", "packages/wechat-renderer/themes/LICENSE-RICO"]
    .map(path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).join("\n\n");
  let manifest = "";
  return [license({ thirdParty: { multipleVersions: true, includePrivate: true,
    output(dependencies) {
      const rust = JSON.parse(readFileSync(new URL("../.generated/rust-licenses.json", import.meta.url), "utf8"));
      manifest = JSON.stringify({ components: [...rust.components, ...dependencies.map(item => ({
        name: item.name, version: item.version, ecosystem: "JavaScript", license: item.license || "未标明",
        url: item.homepage || (item.name ? `https://www.npmjs.com/package/${item.name}` : ""),
        text: [item.licenseText, item.noticeText].filter(Boolean).join("\n\n") || "此组件的发行包未附带许可证正文。",
      }))].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)), notices });
    },
  } }) as Plugin, {
    name: "desktop-license-manifest",
    generateBundle() { this.emitFile({ type: "asset", fileName: "licenses.json", source: manifest }); },
    configureServer(server) {
      // Dev uses the last real bundle's manifest; generate it once with web:build.
      server.middlewares.use("/licenses.json", (_request, response) => {
        try {
          const data = readFileSync(new URL("../apps/desktop/dist/licenses.json", import.meta.url));
          response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(data);
        } catch (error) {
          server.config.logger.error(`Run pnpm web:build to generate licenses: ${error}`);
          response.statusCode = 503; response.end("License manifest not built");
        }
      });
    },
  }];
}
