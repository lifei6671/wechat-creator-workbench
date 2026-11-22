// @vitest-environment jsdom
import { Theme } from "@radix-ui/themes";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Entry } from "../../../../packages/shared-types";
import { SaveQueue } from "../editor/save-queue";
import { PropertiesDialog } from "./Dialogs";

it("suggests historical tags and confirms each tag, including tags containing commas", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const entry: Entry = { id: "draft", kind: "article", title: "标题", contentMd: "正文", status: "draft", categoryId: null,
    tags: ["待整理"], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, updatedAt: 0, deletedAt: null, links: [] };
  const save = vi.fn().mockResolvedValue({ version: 2 });
  const queue = new SaveQueue(entry, save, () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Theme><PropertiesDialog id={entry.id} queue={queue} categories={[]}
      tagSuggestions={["写作指南", "之前使用"]} locked={false} onClose={vi.fn()} onOpen={vi.fn()}
      onSave={async (_, change) => { queue.edit(change); await queue.flush({ retry: true }); }} /></Theme>));
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const change = (value: string) => flushSync(() => {
      inputValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    input.focus();
    change("写作");
    const matches = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    expect(matches.map(option => option.textContent)).toEqual(["写作指南"]);
    flushSync(() => matches[0].click());
    change("主题，工具");
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(save).not.toHaveBeenCalled();
    flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="移除标签 待整理"]')!.click());
    flushSync(() => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("draft", 1, expect.objectContaining({ tags: ["写作指南", "主题，工具"] }), "auto"));
  } finally {
    queue.dispose();
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("reveals only selected empty properties and edits custom types from their icons", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const entry: Entry = { id: "clip", kind: "article", title: "标题", contentMd: "正文", status: "draft", categoryId: null,
    tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 1, updatedAt: 0, deletedAt: null, links: [],
    customProperties: [{ key: "出处", kind: "text", value: "外部资料" }, { key: "空属性", kind: "text", value: "" }] };
  const save = vi.fn().mockResolvedValue({ version: 2 });
  const queue = new SaveQueue(entry, save, () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const choose = async (trigger: HTMLElement, role: string, text: string) => {
    flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    const option = await vi.waitFor(() => {
      const item = [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(row => row.textContent === text);
      expect(item).toBeDefined();
      return item!;
    });
    flushSync(() => option.click());
  };
  const fill = (element: HTMLInputElement, value: string) => flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    flushSync(() => root.render(<Theme><PropertiesDialog id={entry.id} queue={queue} categories={[]}
      tagSuggestions={[]} locked={false} onClose={vi.fn()} onOpen={vi.fn()}
      onSave={async (_, change) => { queue.edit(change); await queue.flush({ retry: true }); }} /></Theme>));
    expect(document.querySelector('[name="summary"]')).toBeNull();
    expect(document.querySelector('input[name="sourceUrl"]')).toBeNull();
    expect([...document.querySelectorAll<HTMLInputElement>(".property-key")].map(key => key.value)).toEqual(["出处"]);
    const add = document.querySelector<HTMLButtonElement>(".property-add")!;
    await choose(add, "menuitem", "摘要");
    await vi.waitFor(() => expect(document.activeElement?.getAttribute("name")).toBe("summary"));
    await choose(add, "menuitem", "新建自定义属性");
    let row = [...document.querySelectorAll<HTMLElement>(".custom-property")].at(-1)!;
    fill(row.querySelector(".property-key")!, "复读日期");
    fill(row.querySelector(".property-value")!, "2026-11-19");
    await choose(row.querySelector(".property-icon")!, "menuitemradio", "日期");
    expect(row.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe("2026-11-19");
    await choose(add, "menuitem", "新建自定义属性");
    row = [...document.querySelectorAll<HTMLElement>(".custom-property")].at(-1)!;
    fill(row.querySelector(".property-key")!, "用途");
    await choose(row.querySelector(".property-icon")!, "menuitemradio", "标签");
    fill(row.querySelector('input[role="combobox"]')!, "待阅读");
    flushSync(() => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith("clip", expect.any(Number), expect.objectContaining({
      customProperties: [
        { key: "出处", kind: "text", value: "外部资料" },
        { key: "空属性", kind: "text", value: "" },
        { key: "复读日期", kind: "date", value: "2026-11-19" },
        { key: "用途", kind: "tags", value: ["待阅读"] },
      ],
    }), "auto"));
    expect(row.querySelector<HTMLInputElement>('input[role="combobox"]')?.value).toBe("");
    expect(row.textContent).toContain("待阅读");
  } finally {
    queue.dispose();
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
