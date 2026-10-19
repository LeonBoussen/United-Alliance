// The Python harness sources, bundled so the demo console can generate real builds in
// the browser. The overseer reads the same files from apps/harness on disk.
const modules = import.meta.glob(["../../../harness/harness/**/*.py", "../../../harness/requirements.txt"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const HARNESS_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, content]) => [path.replace(/^(\.\.\/)+harness\//, ""), content]),
);
