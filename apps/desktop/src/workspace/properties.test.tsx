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
