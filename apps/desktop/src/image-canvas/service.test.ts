import { describe, expect, it, vi } from "vitest";
import type { ImageProject, ImageScene } from "../../../../packages/shared-types";
import { ProjectSaveQueue } from "./service";

const scene = (width: number): ImageScene => ({ schemaVersion: 1, artboard: { width, height: 100, background: { type: "transparent" } }, layers: [],
  layout: { mode: "free", gap: 0, padding: 0, columns: 2, align: "center", size: 0 } });
const project: ImageProject = { id: "project", originEntryId: "entry", baseAssetId: "source", scene: scene(100), version: 1, createdAt: 0, updatedAt: 0, deletedAt: null };

describe("image project save barrier", () => {
  it("serializes writes and drains edits made while an earlier snapshot is saving", async () => {
    let first!: (value: { version: number }) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockResolvedValueOnce({ version: 3 });
    const queue = new ProjectSaveQueue(project, { saveProject: save }, vi.fn());
    queue.set(scene(200));
    const draining = queue.flush();
    queue.set(scene(300));
    expect(queue.flush()).toBe(draining);
    expect(save).toHaveBeenCalledTimes(1);
    first({ version: 2 }); await draining;
    expect(save.mock.calls.map(call => [call[1], call[2].artboard.width])).toEqual([[1, 200], [2, 300]]);
    expect(queue.getVersion()).toBe(3);
    queue.dispose();
  });
  it("retains the failed draft for an explicit retry without advancing its version", async () => {
    const failure = new Error("disk unavailable");
    const save = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ version: 2 });
    const state = vi.fn(); const queue = new ProjectSaveQueue(project, { saveProject: save }, state);
    queue.set(scene(250)); await expect(queue.flush()).rejects.toBe(failure);
    expect(queue.getVersion()).toBe(1);
    expect(state).toHaveBeenLastCalledWith("error", failure);
    await queue.flush();
    expect(save.mock.calls.map(call => [call[1], call[2].artboard.width])).toEqual([[1, 250], [1, 250]]);
    expect(state).toHaveBeenLastCalledWith("saved"); queue.dispose();
  });
});
