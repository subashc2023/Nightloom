/** Item 832: which release build this is. The release roll (`bin/release-roll.sh` in
 *  nightshift-code) counts every build in `state/builds.tsv`, this one included, and exports
 *  the count as `VITE_NIGHTLOOM_BUILD` before the frontend build; Vite bakes it in. A build
 *  without it (a dev build, a hand build) is "dev". */
export function buildLabel(raw: unknown = import.meta.env.VITE_NIGHTLOOM_BUILD): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return /^[1-9]\d*$/.test(s) ? `Build ${s}` : "dev";
}
