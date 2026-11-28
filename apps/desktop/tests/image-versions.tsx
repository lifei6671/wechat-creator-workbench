import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/styles/tokens.css";
import { desktop, type ImageVersionFile } from "../src/desktop";
import { ImageVersions } from "../src/workspace/ImageVersions";
const stamp = Date.now();
const files: ImageVersionFile[] = [
  { name: "文章配图", reasons: [], state: "waiting", assetId: "one", sha256: "one" },
  { name: "拼接长图", reasons: [], state: "waiting", assetId: "two", sha256: "two" },
  { name: "已发布配图", reasons: ["published", "public"], state: null, assetId: "three", sha256: "three" },
  { name: "历史拼接成品", reasons: ["missing"], state: "removed", assetId: "four", sha256: "four" },
].map(item => ({ ...item, renderId: item.assetId, projectId: "project", createdAt: stamp - 40 * 86400000, bytes: 1245184,
  versions: 1, dueAt: stamp + 7 * 86400000, expiresAt: stamp + 30 * 86400000, error: null }));
files[1].location = "s3";
files[1].copyId = "public-two";
desktop.imageVersionStatus = async () => ({ revision: "test", files: structuredClone(files), reclaimableBytes: 2490368 });
desktop.imageVersionKeep = async id => { files.find(file => file.assetId === id)!.reasons = ["retained"]; };
desktop.imageVersionRestore = async id => { const file = files.find(file => file.assetId === id)!; file.state = "restored"; file.reasons = ["retained"]; };
createRoot(document.getElementById("root")!).render(<Theme accentColor="indigo" grayColor="mauve"><ImageVersions onClose={() => {}} /></Theme>);
