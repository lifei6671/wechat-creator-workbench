// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Entry } from "../../../../packages/shared-types";
import { SaveQueue } from "../editor/save-queue";
import { PropertiesDialog, PropertiesPanel } from "./Dialogs";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queue: SaveQueue;
const entry: Entry = { id: "properties-auto", kind: "article", title: "标题", contentMd: "正文", status: "draft", categoryId: null,
  tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, updatedAt: 0, deletedAt: null, links: [] };
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { queue.dispose(); flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(commit = vi.fn<ConstructorParameters<typeof SaveQueue>[1]>().mockImplementation(async (_id, version) => ({ version: version + 1 })), onConflict?: (entry: Entry) => void) {
  const close = vi.fn();
  queue = new SaveQueue(entry, commit, () => {});
  flushSync(() => root.render(<Theme><PropertiesDialog id={entry.id} queue={queue} categories={[]} tagSuggestions={[]}
    locked={false} onOpen={vi.fn()} onClose={close} onConflict={onConflict} onSave={async (_, change) => {
      queue.edit(change); if (!await queue.flush({ retry: true })) throw queue.saveError();
    }} /></Theme>));
  return { commit, close };
}
function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function blur(input: HTMLElement) {
  flushSync(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
}
function key(input: HTMLElement, value: string) {
  flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
function mountPanel(fields: Partial<Entry>, locked = false) {
  const commit = vi.fn<ConstructorParameters<typeof SaveQueue>[1]>().mockImplementation(async (_id, version) => ({ version: version + 1 }));
  queue = new SaveQueue({ ...entry, ...fields }, commit, () => {});
  const flushRef = { current: null as null | (() => Promise<boolean>) };
  const render = (readOnly: boolean) => flushSync(() => root.render(<Theme><PropertiesPanel queue={queue}
    categories={[]} tagSuggestions={["历史标签"]} locked={readOnly} flushRef={flushRef} onClose={vi.fn()} onOpen={vi.fn()}
    onSave={async (_, change) => { queue.edit(change); if (!await queue.flush({ retry: true })) throw queue.saveError(); }} /></Theme>));
  render(locked);
  return { commit, flushRef, render };
}
async function choose(trigger: HTMLElement, text: string) {
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  const option = await vi.waitFor(() => {
    const result = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === text);
    expect(result).toBeDefined(); return result!;
  });
  flushSync(() => option.click());
}

it("serializes blur saves and waits for the latest edits before closing without save or cancel buttons", async () => {
  let resolve!: (result: { version: number }) => void;
  const commit = vi.fn<ConstructorParameters<typeof SaveQueue>[1]>()
    .mockImplementationOnce(() => new Promise(complete => { resolve = complete; }))
    .mockImplementation(async (_id, version) => ({ version: version + 1 }));
  const { close } = mount(commit);
  expect([...document.querySelectorAll("button")].some(button => ["保存", "取消"].includes(button.textContent ?? ""))).toBe(false);
  const title = document.querySelector<HTMLInputElement>('[name="title"]')!;
  fill(title, "第一次修改"); blur(title);
  await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
  fill(title, "第二次修改"); blur(title);
  await choose(document.querySelector(".property-add")!, "摘要");
  const summary = document.querySelector<HTMLTextAreaElement>('[name="summary"]')!;
  fill(summary, "未失焦的摘要");
  flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭内容属性"]')!.click());
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="关闭内容属性"]')?.getAttribute("aria-busy")).toBe("true");
  resolve({ version: 2 });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(commit.mock.calls.map(call => call[1])).toEqual([1, 2, 3]);
  expect(commit.mock.lastCall?.[2]).toMatchObject({ title: "第二次修改", summary: "未失焦的摘要", contentMd: "正文" });
});

it("selects or types platforms, rejects duplicates, saves valid links on blur and removes one platform", async () => {
  const { commit } = mount();
  const add = document.querySelector<HTMLElement>(".property-add")!;
  await choose(add, "发布平台");
  const name = document.querySelector<HTMLInputElement>('[aria-label="发布平台 1"]')!;
  const url = document.querySelector<HTMLInputElement>('[aria-label="发布链接 1"]')!;
  expect(url.disabled).toBe(true);
  flushSync(() => name.focus());
  const preset = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === "CSDN")!;
  flushSync(() => preset.click());
  await vi.waitFor(() => expect(queue.snapshot().fields.publicationPlatforms).toEqual([{ platform: "CSDN", url: "" }]));
  await choose(add, "发布平台");
  const second = document.querySelector<HTMLInputElement>('[aria-label="发布平台 2"]')!;
  fill(second, " csdn "); blur(second);
  expect(document.getElementById(second.getAttribute("aria-describedby")!)?.textContent).toContain("已添加");
  await vi.waitFor(() => expect(queue.isSaving()).toBe(false));
  const title = document.querySelector<HTMLInputElement>('[name="title"]')!;
  fill(title, "其他属性仍可保存"); blur(title);
  await vi.waitFor(() => expect(commit.mock.lastCall?.[2].title).toBe("其他属性仍可保存"));
  expect(document.body.textContent).toContain("已添加");
  const before = commit.mock.calls.length;
  expect(queue.snapshot().fields.publicationPlatforms).toHaveLength(1);
  fill(second, "个人站点"); blur(second);
  await vi.waitFor(() => expect(commit.mock.calls.length).toBeGreaterThan(before));
  const secondUrl = document.querySelector<HTMLInputElement>('[aria-label="发布链接 2"]')!;
  fill(secondUrl, "javascript:alert(1)"); blur(secondUrl);
  expect(document.body.textContent).toContain("HTTP 或 HTTPS");
  fill(secondUrl, "https://example.com/posts/article"); blur(secondUrl);
  await vi.waitFor(() => expect(queue.snapshot().fields.publicationPlatforms).toEqual([
    { platform: "CSDN", url: "" }, { platform: "个人站点", url: "https://example.com/posts/article" },
  ]));
  await choose(document.querySelector<HTMLElement>('[aria-label="发布平台属性菜单 1"]')!, "移除属性");
  await vi.waitFor(() => expect(commit.mock.lastCall?.[2].publicationPlatforms).toEqual([{ platform: "个人站点", url: "https://example.com/posts/article" }]));
});

it("retains a failed edit and retries it on the next blur", async () => {
  const commit = vi.fn<ConstructorParameters<typeof SaveQueue>[1]>()
    .mockRejectedValueOnce(new Error("暂时无法保存"))
    .mockImplementation(async (_id, version) => ({ version: version + 1 }));
  const { close } = mount(commit);
  const title = document.querySelector<HTMLInputElement>('[name="title"]')!;
  fill(title, "保留的修改"); blur(title);
  await vi.waitFor(() => expect(document.body.textContent).toContain("暂时无法保存"));
  expect(title.value).toBe("保留的修改"); expect(close).not.toHaveBeenCalled();
  blur(title);
  await vi.waitFor(() => expect(queue.isDirty()).toBe(false));
  expect(commit).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain("暂时无法保存");
  expect(commit.mock.lastCall?.[2].title).toBe("保留的修改");
});

it("hands all valid property drafts to conflict recovery when closing", async () => {
  const conflict = { code: "VERSION_CONFLICT", currentVersion: 2, message: "内容版本已变化" };
  const commit = vi.fn<ConstructorParameters<typeof SaveQueue>[1]>().mockRejectedValue(conflict);
  const recover = vi.fn();
  const { close } = mount(commit, recover);
  const add = document.querySelector<HTMLElement>(".property-add")!;
  for (const [index, platform] of ["CSDN", "个人站点"].entries()) {
    await choose(add, "发布平台");
    const name = document.querySelector<HTMLInputElement>(`[aria-label="发布平台 ${index + 1}"]`)!;
    fill(name, platform); blur(name);
    await vi.waitFor(() => expect(document.body.textContent).toContain("内容版本已变化"));
  }
  const title = document.querySelector<HTMLInputElement>('[name="title"]')!;
  fill(title, "冲突时未失焦的标题");
  flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭内容属性"]')!.click());
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(recover).toHaveBeenCalledExactlyOnceWith(entry);
  expect(queue.snapshot().fields).toMatchObject({ title: "冲突时未失焦的标题", publicationPlatforms: [
    { platform: "CSDN", url: "" }, { platform: "个人站点", url: "" },
  ] });
  expect(queue.saveError()).toEqual(conflict);
  expect(commit).toHaveBeenCalledOnce();
});

it("keeps newer edits open when an older in-flight save conflicts during close", async () => {
  let reject!: (error: unknown) => void;
  const commit = vi.fn<ConstructorParameters<typeof SaveQueue>[1]>().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const recover = vi.fn();
  const { close } = mount(commit, recover);
  const title = document.querySelector<HTMLInputElement>('[name="title"]')!;
  fill(title, "正在保存的标题"); blur(title);
  await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
  const button = document.querySelector<HTMLButtonElement>('[aria-label="关闭内容属性"]')!;
  flushSync(() => button.click());
  fill(title, "保存期间继续编辑的标题");
  reject({ code: "VERSION_CONFLICT", currentVersion: 2, message: "内容版本已变化" });
  await vi.waitFor(() => expect(button.getAttribute("aria-busy")).not.toBe("true"));
  expect(close).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
  expect(title.value).toBe("保存期间继续编辑的标题");
  await vi.waitFor(() => expect(button.disabled).toBe(false), { timeout: 1500 });
  flushSync(() => button.click());
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(recover).toHaveBeenCalledOnce();
  expect(queue.snapshot().fields.title).toBe("保存期间继续编辑的标题");
  expect(commit).toHaveBeenCalledOnce();
});

it.each(["locked", "deleted"])("keeps %s publication controls read-only for Enter and arrow keys", async mode => {
  const { commit, flushRef } = mountPanel({
    deletedAt: mode === "deleted" ? 1 : null,
    publicationPlatforms: [{ platform: "CSDN", url: "https://example.com/article" }],
  }, mode === "locked");
  const platform = container.querySelector<HTMLInputElement>('[aria-label="发布平台 1"]')!;
  flushSync(() => platform.focus());
  for (const value of ["Enter", "ArrowDown", "ArrowUp", "Enter"]) key(platform, value);
  expect(platform.readOnly).toBe(true);
  expect(platform.value).toBe("CSDN");
  expect(platform.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[aria-label="发布平台选项"]')).toBeNull();
  expect(await flushRef.current!()).toBe(true);
  expect(commit).not.toHaveBeenCalled();
});

it("closes platform suggestions when editing becomes locked without reopening them on unlock", () => {
  const { render } = mountPanel({ publicationPlatforms: [{ platform: "CSDN", url: "" }] });
  flushSync(() => container.querySelector<HTMLInputElement>('[aria-label="发布平台 1"]')!.focus());
  expect(document.querySelector('[aria-label="发布平台选项"]')).not.toBeNull();
  render(true);
  expect(document.querySelector('[aria-label="发布平台选项"]')).toBeNull();
  render(false);
  expect(document.querySelector('[aria-label="发布平台选项"]')).toBeNull();
});

it.each(["Enter", "suggestion"])("saves a custom tag immediately after %s while the input stays focused", async action => {
  const { commit } = mountPanel({ customProperties: [{ key: "主题", kind: "tags", value: ["原标签"] }] });
  const input = container.querySelector<HTMLInputElement>('[aria-label="属性值"]')!;
  flushSync(() => input.focus());
  fill(input, action === "Enter" ? "新标签" : "历史");
  if (action === "Enter") key(input, "Enter");
  else flushSync(() => container.querySelector<HTMLElement>('[role="option"]')!.click());
  await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("");
  expect(commit.mock.lastCall![2].customProperties).toEqual([
    { key: "主题", kind: "tags", value: ["原标签", action === "Enter" ? "新标签" : "历史标签"] },
  ]);
  expect(queue.isDirty()).toBe(false);
});

it("saves custom tag removal without requiring a blur", async () => {
  const { commit } = mountPanel({ customProperties: [{ key: "主题", kind: "tags", value: ["原标签"] }] });
  flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="移除标签 原标签"]')!.click());
  await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
  expect(commit.mock.lastCall![2].customProperties).toEqual([{ key: "主题", kind: "tags", value: [] }]);
  expect(queue.isDirty()).toBe(false);
});


it("does not move focus back to a new platform after the user starts editing its link", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
  mount();
  await choose(document.querySelector<HTMLElement>(".property-add")!, "发布平台");
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  await new Promise(resolve => setTimeout(resolve, 0));
  const platform = document.querySelector<HTMLInputElement>('[aria-label="发布平台 1"]')!;
  fill(platform, "我的站点");
  const url = document.querySelector<HTMLInputElement>('[aria-label="发布链接 1"]')!;
  flushSync(() => url.focus());
  fill(url, "https://example.com/article");
  flushSync(() => { for (const callback of frames.splice(0)) callback(performance.now()); });
  expect(document.activeElement).toBe(url);
  blur(url);
  await vi.waitFor(() => expect(queue.snapshot().fields.publicationPlatforms).toEqual([
    { platform: "我的站点", url: "https://example.com/article" },
  ]));
});
