import type { HarnessBuild } from "@alliance/protocol";
import { realtime } from "./realtime";

/** Download a harness build: from the overseer, or generated in the browser in demo mode. */
export function downloadBuild(build: HarnessBuild): void {
  if (!realtime.isMock) {
    window.location.href = build.downloadUrl;
    return;
  }
  const zip = realtime.buildZip?.(build.id);
  if (!zip) return;
  const url = URL.createObjectURL(new Blob([zip.data.slice().buffer], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = zip.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
