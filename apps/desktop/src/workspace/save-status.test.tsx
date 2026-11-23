// @vitest-environment jsdom
import { act } from "react";
import { Theme } from "@radix-ui/themes";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Entry } from "../../../../packages/shared-types";
import { desktop, type UploadProgress } from "../desktop";
import { SaveQueue } from "../editor/save-queue";
import { StatusBar } from "./StatusBar";

const entry: Entry = {
  id: "images", kind: "article", title: "文章", contentMd: "![图](asset://image)", status: "draft", categoryId: null,
  tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, updatedAt: 0, deletedAt: null, links: [],
};
const noop = () => {};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queue: SaveQueue;
let commit: ReturnType<typeof vi.fn<ConstructorParameters<typeof SaveQueue>[1]>>;
let progress: UploadProgress | null;
let assetRevision: number;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  commit = vi.fn(async (_id: string, version: number) => ({ version: version + 1 }));
  queue = new SaveQueue(entry, commit, noop);
  progress = null;
  assetRevision = 0;
  vi.spyOn(desktop, "imageUploadProgress").mockImplementation(async () => progress);
});
afterEach(async () => {
  await act(async () => root.unmount());
  queue.dispose();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render() {
  await act(async () => root.render(<Theme><StatusBar queue={queue}
    actions={{ mode: "edit", setMode: noop, focusMode: false, onFocusMode: noop, reading: false, publishing: false, onCopyWechat: noop }}
    trashActive={false} settingsOpen={false} mcpRunning={false} backupProgress={null} migrationProgress={null}
    imageStorageEnabled assetRevision={assetRevision++} imageUpload={null} syncBinding={null} syncActivity={null}
    syncError="" onSync={noop} onMcp={noop} onPalette={noop} onTrash={noop} onSettings={noop} onError={noop} /></Theme>));
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
const status = () => container.querySelector('.document-status > [role="status"]:not(.background-status)')!;

it("keeps one saving state across image replacements and waits for the final real save", async () => {
  progress = { completed: 0, total: 4 };
  await render();
  await tick(120);
  expect(status().textContent).toBe("保存中…");
  for (let index = 1; index <= 3; index++) {
    await act(async () => queue.edit({ contentMd: `![图](https://images.example.test/${index}.png)` }));
    await tick(1000);
    expect(commit).toHaveBeenCalledTimes(index);
    expect(queue.isDirty()).toBe(false);
    expect(status().textContent).toBe("保存中…");
    progress = { completed: index, total: 4 };
    await render();
    await tick(120);
    expect(status().textContent).toBe("保存中…");
  }
  let finish!: (result: { version: number }) => void;
  commit.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  progress = null;
  await act(async () => queue.edit({ contentMd: "![图](https://images.example.test/final.png)" }));
  await render();
  await tick(5000);
  expect(commit).toHaveBeenCalledTimes(4);
  expect(queue.isSaving()).toBe(true);
  expect(status().textContent).toBe("保存中…");
  await act(async () => finish({ version: 5 }));
  await tick(999);
  expect(status().textContent).toBe("保存中…");
  await tick(1);
  expect(status().textContent).toBe("已保存");
  expect(commit.mock.lastCall![2].contentMd).toContain("final.png");
});

it("shows save failures immediately during an image batch", async () => {
  progress = { completed: 0, total: 2 };
  await render();
  await tick(120);
  commit.mockRejectedValueOnce(new Error("磁盘写入失败"));
  await act(async () => queue.edit({ contentMd: "![图](https://images.example.test/one.png)" }));
  await tick(750);
  expect(status().textContent).toBe("保存失败");
  expect(status().classList.contains("status-error")).toBe(true);
});

it("keeps ordinary edits immediate and clears image status when changing documents", async () => {
  await render();
  await tick(120);
  await act(async () => queue.edit({ title: "用户编辑" }));
  expect(status().textContent).toBe("未保存");
  await tick(750);
  expect(status().textContent).toBe("已保存");
  progress = { completed: 0, total: 2 };
  await render();
  await tick(120);
  expect(status().textContent).toBe("保存中…");
  queue.dispose();
  queue = new SaveQueue({ ...entry, id: "other" }, commit, noop);
  progress = null;
  await render();
  expect(status().textContent).toBe("已保存");
  await tick(2000);
  expect(status().textContent).toBe("已保存");
});
