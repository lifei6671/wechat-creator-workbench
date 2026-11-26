// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Entry, RecoverySummary } from "../../../../packages/shared-types";
import { desktop } from "../desktop";
import { EditorRecovery } from "./EditorRecovery";

const entry: Entry = { id: "draft", kind: "article", title: "Title", contentMd: "saved body", status: "draft", categoryId: null,
  tags: [], summary: "", source: null, publishedAt: null, publishedUrl: "", version: 4, updatedAt: 0, deletedAt: null, links: [] };
const draft: RecoverySummary = { entryId: "draft", title: "Title", sessionId: "session", baseVersion: 4, localRevision: 3, updatedAt: 1 };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.spyOn(desktop,"entry").mockResolvedValue(entry);
  vi.spyOn(desktop,"recoveryGet").mockResolvedValue({ ...entry, contentMd:"recovered body" });
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!;

it("compares both bodies and disables overwrite when the official version has changed", async () => {
  vi.mocked(desktop.entry).mockResolvedValue({ ...entry, version: 5 });
  flushSync(() => root.render(<EditorRecovery drafts={[draft]} onClose={() => {}} onRecovered={() => {}} />));
  await vi.waitFor(() => expect(document.body.textContent).toContain("recovered body"));
  expect(document.body.textContent).toContain("saved body");
  expect(button("恢复到原文档").disabled).toBe(true);
  expect(button("另存草稿").disabled).toBe(false);
});

it("waits for the real restore and one second of button feedback before closing", async () => {
  const close = vi.fn(), recovered = vi.fn();
  let complete!: (entry: Entry) => void;
  vi.spyOn(desktop,"recoveryRestore").mockImplementation(() => new Promise(resolve => { complete=resolve; }));
  flushSync(() => root.render(<EditorRecovery drafts={[draft]} onClose={close} onRecovered={recovered} />));
  await vi.waitFor(() => expect(button("恢复到原文档").disabled).toBe(false));
  vi.useFakeTimers();
  flushSync(() => button("恢复到原文档").click());
  await vi.advanceTimersByTimeAsync(1200);
  expect(close).not.toHaveBeenCalled();
  expect(button("另存草稿").disabled).toBe(true);
  expect(document.querySelector('.rt-Spinner')).not.toBeNull();
  await act(async () => {
    complete({ ...entry, contentMd:"recovered body", version:5 });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(button("已恢复")).toBeDefined();
  await vi.advanceTimersByTimeAsync(999);
  expect(close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(close).toHaveBeenCalledOnce();
  expect(recovered).toHaveBeenCalledWith(expect.objectContaining({ contentMd:"recovered body" }));
  expect(desktop.recoveryRestore).toHaveBeenCalledWith("draft","session",3,false);
});
