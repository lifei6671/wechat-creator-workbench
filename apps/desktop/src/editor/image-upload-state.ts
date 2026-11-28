import type { ImageUploadState } from "../../../../packages/editor-react";
import { desktop } from "../desktop";

export async function readImageUploadState(url: string): Promise<ImageUploadState> {
  const asset = await desktop.assetDetail(url.slice("asset://".length));
  return {
    pending: Boolean(asset?.uploadStatus && ["queued", "running", "retrying"].includes(asset.uploadStatus)),
    publicUrl: asset?.publicUrl,
    error: asset?.uploadError,
    preserveSource: asset?.preserveSource,
  };
}
