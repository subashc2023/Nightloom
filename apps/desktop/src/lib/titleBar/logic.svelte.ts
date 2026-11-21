// Item 856 (2026-11-19): the behaviour of TitleBar, once. `TitleBar.svelte` (Jarvis) and
// `TitleBarClassic.svelte` mount this and keep only their markup and CSS; `logic.test.ts` beside it fails when
// one look binds to something the other does not. Moved verbatim from TitleBar.svelte's script.
import { chatLabel } from "../chatLabel";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { app } from "../state.svelte";
import { isMac } from "../platform";

export type TitleBarLogicProps = Record<string, never>;



export function titleBarLogic(props: () => TitleBarLogicProps) {

  /**
   * The window's own chrome, drawn in the webview because the system frame is
   * off on Windows and Linux (see `build_window` in `main.rs`). Everything a
   * title bar is expected to do has to be done here rather than assumed: drag
   * and double-click-to-maximize come from `data-tauri-drag-region="deep"`,
   * which Tauri's injected handler reads — clickable elements inside it block
   * the drag on their own, so the buttons need no opt-out.
   *
   * **macOS draws none of it.** The frame is native there, so a bar of ours
   * would be a second one under the system's, and the commands that would
   * have sat in it are in the menu bar instead (`mac_menu`). What is left for
   * this component on that platform is the window title, which the native bar
   * displays and so matters there more than anywhere.
   */
  const win = getCurrentWindow();

  /**
   * Two things the system used to track for us. The maximize button has two
   * glyphs and they are not interchangeable — a restore icon on a windowed
   * window is the one wrong thing a caption bar can do and still look
   * plausible — and `onResized` is what reports the state, since dragging a
   * window to the top edge maximizes it without the button being touched.
   * Focus dims the bar the way every native one does, which is most of what
   * makes a background window read as a background window.
   */
  let maximized = $state(false);
  let focused = $state(true);

  $effect(() => {
    // Both answers describe chrome that macOS draws itself, so there is
    // nothing there for them to be true of.
    if (isMac) return;
    let alive = true;
    const stops: UnlistenFn[] = [];
    // A listener that resolves after the effect is torn down has to stop
    // itself; nothing else is holding it any more.
    const keep = (stop: UnlistenFn) => {
      if (alive) stops.push(stop);
      else stop();
    };
    // `onResized` fires every frame of a resize drag and the answer is a
    // round trip, so the checks are coalesced rather than queued: one in
    // flight at a time, and one more afterwards if anything arrived while it
    // was out. Dropping the trailing event instead would be the cheap version
    // and would leave the glyph wrong exactly when the drag ended on a
    // maximize.
    let checking = false;
    let again = false;
    const sync = () => {
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      void win
        .isMaximized()
        .then((m) => (maximized = m))
        .finally(() => {
          checking = false;
          if (again) {
            again = false;
            sync();
          }
        });
    };
    sync();
    void win.onResized(sync).then(keep);
    void win.onFocusChanged(({ payload }) => (focused = payload)).then(keep);
    return () => {
      alive = false;
      for (const stop of stops) stop();
    };
  });

  /**
   * What the window is called, which in a chat app is what the chat is
   * called: five alt-tab entries all reading "Nightloom" say less than the
   * names the sidebar is already showing. `title ?? first_user` for the same
   * reason every other list does it — a log written before names existed has
   * no title and is not nameless.
   */
  const label = $derived.by(() => {
    const open = app.sessions.find((s) => s.id === app.activeSessionId);
    const name = open ? chatLabel(open, "") || null : null;
    if (name) return name.length > 64 ? `${name.slice(0, 64)}…` : name;
    return app.project?.name ?? null;
  });

  /**
   * The taskbar and the switcher read the OS title, not the bar, so it is set
   * rather than only drawn.
   *
   * macOS gets the bare name: the app's own is in the menu bar two
   * millimetres above, and a window titled "Draft — Nightloom" beside a menu
   * bar reading "Nightloom" is the app saying its name twice. Windows and
   * Linux have no menu bar to say it once, and their switchers show the title
   * and nothing else.
   */
  $effect(() => {
    if (isMac) void win.setTitle(label ?? "Nightloom");
    else void win.setTitle(label ? `${label} — Nightloom` : "Nightloom");
  });

  /*
   * Resizing is not here, and the first draft had eight edge grips calling
   * `startResizeDragging`. `tauri-runtime-wry`'s `undecorated_resizing`
   * already does it — a `TAURI_DRAG_RESIZE_BORDERS` child window on Windows
   * (visible in the live window's child list) and a GTK button-press handler
   * on the webview for Linux, both hit-testing a five-pixel inset and both
   * checking resizable-and-not-maximized. The grips reimplemented that, with
   * the same inset, over the top of it.
   */

  return {
    get focused() {
      return focused;
    },
    set focused(v) {
      focused = v;
    },
    get label() {
      return label;
    },
    get maximized() {
      return maximized;
    },
    set maximized(v) {
      maximized = v;
    },
    get win() {
      return win;
    },
  };
}
