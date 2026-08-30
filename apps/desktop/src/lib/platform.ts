/**
 * Which OS this window is running on, spelled the way `std::env::consts::OS`
 * spells it ("windows" / "linux" / "macos").
 *
 * It arrives as a global set by an initialization script rather than over a
 * command, because the title bar needs it *before the first paint*: the
 * window buttons are ours on Windows and Linux and the system's on macOS, so
 * an answer that resolved a turn of the event loop later would lay the bar
 * out twice — once wrong, visibly. `main.rs` sets it on the window it builds,
 * which is also the only place that knows it for certain; sniffing the user
 * agent would be guessing at the same fact from the webview's own vendor.
 *
 * Empty outside a Tauri window (a bare `vite preview`), which reads as "no
 * platform-specific chrome" rather than as the wrong platform's.
 */
export const platform: string =
  (globalThis as unknown as { __NIGHTLOOM_PLATFORM__?: string }).__NIGHTLOOM_PLATFORM__ ?? "";

/**
 * macOS keeps its system frame, whole. There is therefore no bar of ours on
 * that platform at all — a second one under the system's is the opposite of
 * native — and what would have gone in it is in the menu bar instead, which
 * is where a Mac user looks for an app's commands anyway.
 */
export const isMac = platform === "macos";
