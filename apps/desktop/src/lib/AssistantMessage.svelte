<script lang="ts">
  import type { Segment } from "./state.svelte";
  import type { ApprovalRequest, Usage } from "./types";
  import { renderMarkdown } from "./markdown";
  import { wordDiff } from "./textdiff";
  import { exactTime, relativeTimeLong } from "./time";
  import { compactJson } from "./toolinput";
  import {
    flipOverride,
    resolveOpen,
    segmentIds,
    toolInputSummary,
    toolResultSummary,
    toolSummary,
    transcript,
    type BlockKind,
    type Override,
  } from "./transcriptPrefs.svelte";
  import {
    HIDDEN_THINKING_TITLE,
    activitySummary,
    groupSegments,
    modelOmitsThinking,
    resolveFolded,
    shortToolName,
    thinkingHidden,
    workingLabel,
  } from "./activity";
  import type { IconName } from "./icons";
  import { fmtShare, fmtTokens, shareOf, sizeTitle, type TurnSize } from "./tokens";
  import {
    artifactLinks,
    displayPath,
    extOf,
    fmtSize,
    pathCandidates,
    type ArtifactLink,
  } from "./cards";
  import * as api from "./api";
  import { addToast, app } from "./state.svelte";
  import ApprovalPrompt from "./ApprovalPrompt.svelte";
  import Icon from "./Icon.svelte";
  import { REMOVED_TEXT_PLACEHOLDER, REMOVED_TOOL_PLACEHOLDER } from "./edit";

  interface Footer {
    model: string;
    usage: Usage;
    stop_reason: string | null;
    cost?: number;
    /** When the reply was recorded — its completion (backlog 123). */
    at?: string;
  }

  /** The turn's text segments, for Copy — thinking and tool traffic are not
   *  what anyone means by "copy the reply". */
  function textOf(): string {
    return segs
      .filter((s) => s.kind === "text")
      .map((s) => s.text)
      .join("\n\n");
  }
  let copied = $state(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(textOf());
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      // The webview refused the clipboard; nothing to show but the button.
    }
  }
  // The footer says what the reply itself is (backlog 090): its output,
  // and what its tool calls brought back when any did. It used to sum
  // `input + output`, which on both engines is the whole prompt plus the
  // reply — the gauge's figure, near enough, and neither the message nor
  // the total. The prompt's size is still in the title.
  function fmtOut(u: Usage, size: TurnSize | null): string {
    const out = `${u.output_tokens.toLocaleString()} out`;
    return size?.results ? `${out} · ${fmtTokens(size.results)} from tools` : out;
  }
  function footerTitle(f: Footer, size: TurnSize | null): string {
    const base = `${f.usage.input_tokens.toLocaleString()} in (the whole prompt, cached or not) / ${f.usage.output_tokens.toLocaleString()} out${f.stop_reason ? ` · ${f.stop_reason}` : ""}`;
    return size ? `${sizeTitle(size, "assistant", limit)}. ${base}` : base;
  }
  function fmtCost(c: number | undefined): string {
    if (c == null) return "";
    return c > 0 && c < 0.01 ? ` · $${c.toFixed(4)}` : ` · $${c.toFixed(2)}`;
  }
  /**
   * The footer's figure (the design's board 1, 2026-09-16): what the turn
   * added to the window — the reply and what its tools brought back, the
   * same number the bar beside it is a share of — with the reply's own
   * `N out` in the title. Without a size to show, the output count as
   * before.
   */
  function fmtFigure(u: Usage, size: TurnSize | null): string {
    return size ? fmtTokens(size.tokens) : fmtOut(u, null);
  }

  /**
   * The row's icon by the call's name (board 1): the CLI's tools by name,
   * an MCP tool by its prefix, Nightloom's own engine's snake_case tools by
   * what they do; null for anything else, which keeps the ⚒ glyph.
   */
  function toolIcon(name: string): IconName | null {
    if (name.startsWith("mcp__")) return "mcp";
    const n = name.toLowerCase();
    if (n === "agent" || n === "task") return "agent";
    if (n.startsWith("read") || n === "notebookread" || n === "read_chat") return "read";
    if (n.startsWith("grep") || n.startsWith("glob") || n.includes("search")) return "grep";
    if (n.startsWith("edit") || n.startsWith("write") || n === "multiedit" || n === "notebookedit") return "edit";
    if (n === "bash") return "term";
    if (n.includes("fetch")) return "ext";
    return null;
  }

  /**
   * The thinking row's words, three states (boards 1 and 6, backlog 097):
   * `thought for 6 s` once done with a clock; `thought · summary` when the
   * text is the summary the API engine asked for — a model that omits its
   * thinking returned something, so it is that; `thought` for a recorded
   * block with no clock; `thinking` while it streams.
   */
  function thoughtLabel(seg: { done: boolean; ms?: number }): string {
    if (!seg.done) return "thinking";
    if (summarised) return "thought · summary";
    if (seg.ms == null) return "thought";
    const sec = Math.max(1, Math.round(seg.ms / 1000));
    return sec < 60 ? `thought for ${sec} s` : `thought for ${Math.floor(sec / 60)} min ${sec % 60} s`;
  }
  /** The summary's first line, for the row's argument column. */
  function firstLine(text: string): string {
    return text.trim().split(/\n/, 1)[0] ?? "";
  }

  let {
    segs,
    footer = null,
    streaming = false,
    since = null,
    size = null,
    limit = null,
    approvals = [],
    onremove = null,
    onrestore = null,
    controlsTitle = "",
    originals = null,
    diff = false,
    clock = Date.now(),
  }: {
    segs: Segment[];
    footer?: Footer | null;
    streaming?: boolean;
    /** When the live turn was sent (ms since epoch), for the `working · 41 s`
     *  row (backlog 096); absent, the count starts when this mounts. */
    since?: number | null;
    /** What this reply added to the context (backlog 090), null when the
     *  log cannot say; `limit` is the model's window for the share. */
    size?: TurnSize | null;
    limit?: number | null;
    /** Calls in these segments still waiting on the user's decision. */
    approvals?: ApprovalRequest[];
    /** Remove one block of a recorded reply — a tool call with its
     *  result, from the hover on the call (nightshift backlog 066). Given
     *  only when the reply can be edited: recorded, live, not removed, no
     *  turn running. */
    onremove?: ((block: number) => void) | null;
    /** Restore a removed block from its placeholder. Same terms. */
    onrestore?: ((block: number) => void) | null;
    /** What hovering the controls says on this engine. */
    controlsTitle?: string;
    /** Per segment, a text block's words before its edit (nightshift
     *  backlog 105) — `null` where the block was not edited, `""` for one
     *  the edit appended; absent on a reply never edited. */
    originals?: (string | null)[] | null;
    /** Draw each edited block as a diff over its current text rather than
     *  as the rendered text: the transcript's `edited` mark toggles it. */
    diff?: boolean;
    /** The transcript's clock (ms since epoch), ticking while the chat is
     *  open, so the footer's `37 minutes ago` keeps up (backlog 123). */
    clock?: number;
  } = $props();

  // Per-block clicks, keyed by the block's stable id (`segmentIds`) rather
  // than its index, and consulted before the streaming rule and the two
  // transcript-wide toggles (`resolveOpen`, nightshift backlog 052): a click
  // on a block always wins over its default. The map is this component's,
  // so it lives as long as the message on screen does. An activity block's
  // fold line (backlog 096) keeps its click here too, under `block:<id>`.
  let overrides = $state<Record<string, Override>>({});
  const ids = $derived(segmentIds(segs));
  // The reply as the transcript draws it: runs of thinking and tool calls
  // as one activity block each, everything else on its own (backlog 096).
  const groups = $derived(groupSegments(segs, ids));

  function kindOf(seg: Segment): BlockKind {
    return seg.kind === "thinking" ? "thinking" : "tool";
  }
  function doneOf(seg: Segment): boolean {
    if (seg.kind === "thinking") return seg.done;
    if (seg.kind === "tool") return seg.call.result !== null;
    return true;
  }
  function isOpen(i: number, seg: Segment): boolean {
    return resolveOpen(kindOf(seg), ids[i], streaming, doneOf(seg), overrides, transcript);
  }
  function toggle(i: number, seg: Segment): void {
    overrides[ids[i]] = flipOverride(
      kindOf(seg),
      ids[i],
      streaming,
      doneOf(seg),
      overrides,
      transcript,
    );
  }
  function isFolded(key: string): boolean {
    return resolveFolded(key, streaming, overrides, transcript);
  }
  function toggleFold(key: string): void {
    overrides[key] = { open: isFolded(key), rev: transcript.rev.tool };
  }

  // Toggled on pointerdown, not click. While a reply streams the transcript
  // stays pinned to its foot and every delta pushes the pill up the page,
  // so between the press and the release the pointer is over something
  // else and no `click` reaches the button — which is what "clicking a
  // thinking tag mid-reply does nothing" looks like (backlog 052). The
  // press is a single instant and cannot be split. `click` is kept for the
  // keyboard, where `detail` is 0; a pointer's click has already been
  // handled at its press.
  function press(e: PointerEvent, i: number, seg: Segment): void {
    if (e.button !== 0) return;
    toggle(i, seg);
  }
  function keyClick(e: MouseEvent, i: number, seg: Segment): void {
    if (e.detail === 0) toggle(i, seg);
  }
  function pressFold(e: PointerEvent, key: string): void {
    if (e.button !== 0) return;
    toggleFold(key);
  }
  function keyFold(e: MouseEvent, key: string): void {
    if (e.detail === 0) toggleFold(key);
  }

  // The moon stays for the whole live turn (backlog 096): the waiting row
  // of backlog 049 covers send-to-first-token, and from the first token on
  // this message's last row is the moon with `working · 41 s`, counted
  // from when the turn was sent. Inside the last activity block when the
  // reply's last segment is in one, else a row of its own under the text.
  // Gone the moment `streaming` drops.
  let now = $state(Date.now());
  const startedAt = Date.now();
  $effect(() => {
    if (!streaming) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const working = $derived(workingLabel(now - (since ?? startedAt)));
  const summarised = $derived(!!footer && modelOmitsThinking(footer.model));
  // The block the moon rides is the last one, whether or not text follows
  // it (board 1 draws the moon as the block's last row with the reply's
  // words under it); with no block yet it sits under the text alone.
  const lastGroup = $derived([...groups].reverse().find((g) => g.kind === "activity"));
  const moonInBlock = $derived(streaming && !!lastGroup);
  const moonAlone = $derived(streaming && segs.length > 0 && !moonInBlock);

  // The cards under the reply (backlog 078): an artifact the model published
  // and a file it wrote, read out of the reply's text once it has stopped
  // streaming — a path half-typed mid-stream is not a file yet. The links
  // are a pure function of the text; the files are whatever the backend
  // finds on disk among the candidates, so a path the model made up stays
  // text. Run once per finished reply: a recorded reply's text never changes.
  interface FileCard {
    path: string;
    label: string;
    size: number;
  }
  const roots = $derived(
    [app.connection?.workspace, app.project?.root].filter((r): r is string => !!r),
  );
  const replyText = $derived(textOf());
  const links = $derived<ArtifactLink[]>(streaming ? [] : artifactLinks(replyText));
  let files = $state<FileCard[]>([]);
  let checked = "";
  $effect(() => {
    if (streaming) return;
    const text = replyText;
    const bases = roots;
    const key = `${bases.join("\0")}\0${text}`;
    if (key === checked) return;
    checked = key;
    const candidates = pathCandidates(text, bases);
    if (candidates.length === 0) {
      files = [];
      return;
    }
    let stale = false;
    void api
      .namedFiles(candidates.map((c) => c.path))
      .then((found) => {
        if (stale) return;
        files = found.flatMap((f) =>
          f ? [{ path: f.path, label: displayPath(f.path, bases), size: f.size }] : [],
        );
      })
      .catch(() => {
        // The backend could not look; nothing to draw, nothing to say.
        if (!stale) files = [];
      });
    return () => {
      stale = true;
    };
  });
  async function openLink(url: string): Promise<void> {
    try {
      await api.openUrl(url);
    } catch (e) {
      addToast(`Could not open the link: ${String(e)}`);
    }
  }
  async function openFile(path: string): Promise<void> {
    try {
      await api.openFile(path);
    } catch (e) {
      addToast(`Could not open: ${String(e)}`);
    }
  }
  async function revealFile(path: string): Promise<void> {
    try {
      await api.revealFile(path);
    } catch (e) {
      addToast(`Could not reveal: ${String(e)}`);
    }
  }
</script>

{#snippet subagent(children: Segment[])}
  {@const calls = children.filter((c) => c.kind === "tool").length}
  {@const names = children
    .filter((c) => c.kind === "tool")
    .map((c) => (c.kind === "tool" ? shortToolName(c.call.name) : ""))
    .slice(0, 4)
    .join(", ")}
  {@const words = children
    .filter((c) => c.kind === "text")
    .reduce((n, c) => n + (c.kind === "text" ? c.text.split(/\s+/).filter(Boolean).length : 0), 0)}
  <details class="sub">
    <summary class="sub-line">
      <span class="ico">▸</span>
      <span class="name">subagent</span>
      <span class="arg">
        {#if names}{names}{calls > 4 ? ", …" : ""}{" · "}{/if}{#if calls}{calls} call{calls === 1 ? "" : "s"}{/if}{#if calls && words}{" · "}{/if}{#if words}{words} words{streaming ? " so far" : ""}{/if}
      </span>
    </summary>
    <div class="sub-body">
      {#each children as c, k (k)}
        {#if c.kind === "tool"}
          {@const icon = toolIcon(c.call.name)}
          <div class="arow static" class:error={!!c.call.result?.is_error}>
            <span class="ico">{#if icon}<Icon name={icon} size={13} />{:else}⚒{/if}</span>
            <span class="name" title={c.call.name}>{shortToolName(c.call.name)}</span>
            <span class="arg">{toolInputSummary(c.call.input)}</span>
            <span class="size">{toolResultSummary(c.call, streaming)}</span>
          </div>
          {#if c.call.children?.length}
            {@render subagent(c.call.children)}
          {/if}
        {:else if c.kind === "thinking"}
          <div class="arow static thinking">
            <span class="ico"><Icon name="think" size={13} /></span>
            <span class="name">thought</span>
            <span class="arg">{c.text}</span>
            <span class="size"></span>
          </div>
        {:else if c.kind === "redacted"}
          <div class="arow static thinking">
            <span class="ico"><Icon name="think" size={13} /></span>
            <span class="name">redacted thinking</span>
            <span class="arg"></span>
            <span class="size"></span>
          </div>
        {:else if c.kind === "text"}
          <pre class="sub-text">{c.text}</pre>
        {/if}
      {/each}
    </div>
  </details>
{/snippet}


<div class="assistant">
  {#if footer}
    <span class="ns-k">{footer.model}</span>
  {/if}
  {#each groups as g (g.kind === "activity" ? g.key : `one:${g.i}`)}
    {#if g.kind === "activity"}
      {@const folded = isFolded(g.key)}
      {@const last = moonInBlock && g === lastGroup}
      <!-- One block for the run: a left rule, accent while the turn is
           live; a summary line that folds and unfolds the rows; the rows
           on one grid — icon · name · argument · size (backlog 096). -->
      <div class="activity" class:live={streaming}>
        <button
          class="fold"
          aria-expanded={!folded}
          title={folded ? "Show the calls" : "Fold to one line"}
          onpointerdown={(e) => pressFold(e, g.key)}
          onclick={(e) => keyFold(e, g.key)}
        >
          <span class="caret">{folded ? "▸" : "▾"}</span>
          <span class="fold-text">{activitySummary(g.rows, streaming)}</span>
        </button>
        {#if !folded}
          {#each g.rows as { seg, i } (ids[i] || i)}
            {#if seg.kind === "thinking"}
              {#if thinkingHidden(seg)}
                <!-- The model thought and returned nothing of it (backlog
                     097): a fact in the dim style, no pointer, nothing to
                     open — a button here did nothing, which is what he
                     saw. -->
                <div class="arow static thinking hidden wide" title={HIDDEN_THINKING_TITLE}>
                  <span class="ico"><Icon name="think" size={13} /></span>
                  <span class="name">thought · hidden by the model</span>
                  <span class="size"></span>
                </div>
              {:else if !seg.done && seg.text.trim() === ""}
                <!-- Begun, nothing arrived yet: under way, not yet a button. -->
                <div class="arow static thinking wide">
                  <span class="ico"><Icon name="think" size={13} /></span>
                  <span class="name">thinking</span>
                  <span class="size">…</span>
                </div>
              {:else}
                {@const summary = summarised && seg.done}
                <div class="row-wrap">
                  <button
                    class="arow thinking"
                    class:wide={!summary}
                    aria-expanded={isOpen(i, seg)}
                    title={isOpen(i, seg) ? "Hide the thinking" : "Show the thinking"}
                    onpointerdown={(e) => press(e, i, seg)}
                    onclick={(e) => keyClick(e, i, seg)}
                  >
                    <span class="ico"><Icon name="think" size={13} /></span>
                    <span class="name">{thoughtLabel(seg)}</span>
                    {#if summary}<span class="arg summary">{firstLine(seg.text)}</span>{/if}
                    <span class="size">{seg.done ? (isOpen(i, seg) ? "▾" : "▸") : "…"}</span>
                  </button>
                  {#if isOpen(i, seg)}
                    <div class="thinking-text">{seg.text}</div>
                  {/if}
                </div>
              {/if}
            {:else if seg.kind === "redacted"}
              <div class="arow static thinking wide">
                <span class="ico"><Icon name="think" size={13} /></span>
                <span class="name">redacted thinking</span>
                <span class="size"></span>
              </div>
            {:else if seg.kind === "tool"}
              {@const open = isOpen(i, seg)}
              {@const bad = !!seg.call.result?.is_error || !!seg.call.denied}
              {@const icon = toolIcon(seg.call.name)}
              <div class="row-wrap tool">
                <button
                  class="arow"
                  class:error={bad}
                  aria-expanded={open}
                  title={open ? "Collapse to one line" : "Expand this call"}
                  onpointerdown={(e) => press(e, i, seg)}
                  onclick={(e) => keyClick(e, i, seg)}
                >
                  <span class="ico">{#if icon}<Icon name={icon} size={13} />{:else}⚒{/if}</span>
                  <span class="name" title={seg.call.name}>{shortToolName(seg.call.name)}</span>
                  <span class="arg">{toolInputSummary(seg.call.input)}</span>
                  <span class="size">{toolResultSummary(seg.call, streaming)}</span>
                </button>
                {#if open}
                  <!-- The full call: its whole input, then what came back. -->
                  <div class="tool-full">{compactJson(seg.call.input)}</div>
                  {#if seg.call.denied}
                    <!-- The reason can come from the gate itself (a cancelled turn
                         refuses what it left parked), so it stands in for "you said no"
                         rather than being appended to it. -->
                    <div class="denied-note">
                      Not run — permission denied{seg.call.result?.content
                        ? `: ${seg.call.result.content}`
                        : "."}
                    </div>
                  {:else if seg.call.result}
                    <pre
                      class="tool-result"
                      class:error={seg.call.result.is_error}>{seg.call.result.content}</pre>
                  {/if}
                {/if}
                <!-- Outside the collapse: a call parked at the gate needs its prompt
                     on screen whatever the toggle says, or the turn waits on a
                     decision nobody can see. -->
                {#each approvals.filter((a) => a.id === seg.call.id) as req (req.id)}
                  <ApprovalPrompt {req} />
                {/each}
                <!-- The subagent this call spawned (backlog 075): one indented
                     row that opens to the child's turn — its calls, thinking and
                     words, nested subagents included. Live the children are
                     segments of their own; from the log they are the recorder's
                     narrative, one text segment. Outside the collapse, like the
                     prompt: a subagent at work is what the row is about. -->
                {#if seg.call.children?.length}
                  {@render subagent(seg.call.children)}
                {/if}
                <!-- The hover on the call itself (backlog 066): the call and its
                     result leave the context together, the log keeps both. -->
                {#if onremove && seg.block != null}
                  <span class="block-tools" title={controlsTitle}>
                    <button
                      class="tool-btn"
                      title="Remove this tool call and its result from the context. Both stay in the log; Restore is on the placeholder."
                      aria-label="Remove this tool call and its result from the context"
                      onclick={() => onremove?.(seg.block!)}
                    >
                      <Icon name="minus" size={12} />
                    </button>
                  </span>
                {/if}
              </div>
            {/if}
          {/each}
        {:else}
          <!-- A parked prompt still shows through a folded block. -->
          {#each g.rows as { seg, i } (i)}
            {#if seg.kind === "tool"}
              {#each approvals.filter((a) => a.id === seg.call.id) as req (req.id)}
                <ApprovalPrompt {req} />
              {/each}
            {/if}
          {/each}
        {/if}
        {#if last}
          <div class="working" role="status" aria-label={working}>
            <span class="roll" aria-hidden="true"><Icon name="moon" size={14} /></span>
            <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="working-text">{working}</span>
          </div>
        {/if}
      </div>
    {:else if g.seg.kind === "text"}
      {#if diff && originals?.[g.i] != null}
        {@const before = originals[g.i]!}
        <!-- The edit as a diff over the markdown source (backlog 105): the
             source is what he edited, and a mark inside rendered HTML would
             have to cross links and code spans. The transcript's face. -->
        <div class="markdown textdiff">
          {#each wordDiff(before, g.seg.text) as op, k (k)}{#if op.kind === "del"}<del>{op.text}</del>{:else if op.kind === "add"}<ins>{op.text}</ins>{:else}{op.text}{/if}{/each}
        </div>
      {:else}
        <div class="markdown">{@html renderMarkdown(g.seg.text)}</div>
      {/if}
    {:else if g.seg.kind === "removed_tool" || g.seg.kind === "removed_text"}
      {@const seg = g.seg}
      <!-- A removed block's placeholder, greyed, the original a click
           away, Restore beside it (backlog 066). -->
      <div class="removed-block">
        <details class="removed-original">
          <summary>
            <span class="removed-label">
              {seg.kind === "removed_tool" ? REMOVED_TOOL_PLACEHOLDER : REMOVED_TEXT_PLACEHOLDER}
            </span>
          </summary>
          {#if seg.kind === "removed_tool"}
            <div class="removed-body tool-chip line">
              <span class="tool-line">{toolSummary(seg.call, false)}</span>
            </div>
            {#if seg.call.result}
              <pre class="tool-result" class:error={seg.call.result.is_error}>{seg.call.result.content}</pre>
            {/if}
          {:else}
            <div class="removed-body">{seg.text}</div>
          {/if}
        </details>
        {#if onrestore}
          <button
            class="tool-btn"
            title="Restore to the context"
            aria-label="Restore to the context"
            onclick={() => onrestore?.(seg.block)}
          >
            <Icon name="refresh" size={12} />
          </button>
        {/if}
      </div>
    {:else if g.seg.kind === "notice"}
      <div class="notice">{g.seg.text}</div>
    {/if}
  {/each}
  {#if moonAlone}
    <div class="working" role="status" aria-label={working}>
      <span class="roll" aria-hidden="true"><Icon name="moon" size={20} /></span>
      <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="working-text">{working}</span>
    </div>
  {/if}
  {#if !streaming && (links.length > 0 || files.length > 0)}
    <!-- Under the reply text, not inline in it (backlog 078): an artifact
         result as a link card, a file the reply names as the attachment
         card — extension badge, path, size, Open, Reveal. -->
    <div class="cards">
      {#each links as l (l.url)}
        <div class="card link" title={l.url}>
          <span class="card-ico"><Icon name="link" size={14} /></span>
          <span class="card-text">
            <span class="card-title">{l.title}</span>
            <span class="card-sub">{l.url.replace(/^https?:\/\//, "")}</span>
          </span>
          <button class="ns-btn ghost small" title="Open in the browser" onclick={() => void openLink(l.url)}>Open <Icon name="ext" size={11} /></button>
        </div>
      {/each}
      {#each files as f (f.path)}
        <div class="card file" title={f.path}>
          <span class="card-ext">{extOf(f.path)}</span>
          <span class="card-text">
            <span class="card-title mono">{f.label}</span>
          </span>
          <span class="card-size">{fmtSize(f.size)}</span>
          <button class="ns-btn ghost small" title="Open with its application" onclick={() => void openFile(f.path)}>Open</button>
          <button class="ns-btn ghost small" title="Show in the file manager" onclick={() => void revealFile(f.path)}>Reveal</button>
        </div>
      {/each}
    </div>
  {/if}
  {#if footer && !streaming}
    {@const share = size ? shareOf(size.tokens, limit) : null}
    <div class="footer">
      <button class="ns-btn ghost small" onclick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      <span class="meta" title={footerTitle(footer, size)}>{fmtFigure(footer.usage, size)}{fmtCost(footer.cost)}</span>
      {#if fmtShare(share)}
        <!-- The reply's share of the window (backlog 090), the gauge's bar
             scaled to it, once the reply is worth a bar. -->
        <span class="meta share" title={size ? sizeTitle(size, "assistant", limit) : ""}>
          <span class="share-bar" aria-hidden="true"><span class="share-fill" style:width="{(share ?? 0) * 100}%"></span></span>
          {fmtShare(share)}
        </span>
      {/if}
      {#if footer.at}
        <!-- When the reply landed (backlog 123): in words, the exact
             moment on hover, as Claude Code's footer does. -->
        <span class="meta when" title={exactTime(footer.at)}>{relativeTimeLong(footer.at, clock)}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .assistant {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
    max-width: 640px;
  }
  .assistant :global(.markdown) {
    /* Plex Sans, the interface face, since 2026-09-14: the editorial serif
       read as academic to him ("looks like Times New Roman almost"), and of
       the seven faces compared side by side he chose the one the chrome
       already uses. The per-user choice (nightshift backlog 051) arrives as
       two root properties set by `transcriptPrefs`; the fallbacks are his
       defaults. */
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 16px);
    line-height: 1.55;
    color: var(--ink);
  }
  /* The edit as a diff (backlog 105): the source pre-wrapped in the same
     face, the code diff view's colours, removed spans struck through. */
  .textdiff {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .textdiff del {
    background: var(--del-bg);
    color: var(--del-fg);
    text-decoration: line-through;
    text-decoration-color: var(--del-fg);
    border-radius: 3px;
  }
  .textdiff ins {
    background: var(--add-bg);
    color: var(--add-fg);
    text-decoration: none;
    border-radius: 3px;
  }
  /* The activity block (backlog 096): one bordered group with a left rule
     — accent while the turn is live, the panel line once done — and its
     rows on a shared grid so the names, arguments and sizes line up. */
  .activity {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-left: 2px solid var(--line2);
    border-radius: 8px;
    background: color-mix(in srgb, var(--sheet) 60%, transparent);
    min-width: 0;
    /* Not `overflow: hidden`: the call's hover Remove (backlog 066) sits
       past the right edge. */
  }
  .activity.live {
    border-left-color: var(--accent);
  }
  /* The board's measures (claude-code-ui-design-2026-09-16, board 1): rows
     28px tall on one grid — icon 18 · name 118 · argument · size — a
     hairline between neighbours, 12px in from either edge. */
  .activity > * + * {
    border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  }
  /* The subagent row under an Agent call (backlog 075): the disclosure's
     summary drawn like a row, indented one column in on the paper, its
     body one rule in. */
  .sub {
    margin: 0;
    border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
    background: color-mix(in srgb, var(--paper) 50%, transparent);
  }
  .sub-line {
    display: grid;
    grid-template-columns: 18px minmax(0, auto) minmax(0, 1fr);
    column-gap: 10px;
    align-items: center;
    min-height: 28px;
    cursor: pointer;
    list-style: none;
    color: var(--dim);
    font-size: 0.78rem;
    padding: 5px 12px 5px 40px;
  }
  .sub-line .arg {
    color: var(--ink2);
  }
  .sub-line::-webkit-details-marker {
    display: none;
  }
  .sub[open] > .sub-line .ico {
    transform: rotate(90deg);
    display: inline-block;
  }
  .sub-body {
    border-left: 2px solid var(--line);
    padding-left: 0.6rem;
    margin: 0 12px 6px 40px;
  }
  .sub-body .arow {
    padding-left: 0;
    padding-right: 0;
  }
  .sub-text {
    margin: 2px 0;
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
    font-family: inherit;
  }
  .fold,
  .arow {
    display: grid;
    grid-template-columns: 18px 118px minmax(0, 1fr) auto;
    column-gap: 10px;
    align-items: center;
    width: 100%;
    min-width: 0;
    min-height: 28px;
    background: none;
    border: none;
    padding: 5px 12px;
    text-align: left;
    color: var(--dim);
    font-size: 0.78rem;
    cursor: pointer;
    user-select: none;
  }
  /* The one-line summary that folds the block: the board's mono, dim. */
  .fold {
    grid-template-columns: 18px minmax(0, 1fr);
  }
  /* A row with nothing in the argument column lets its name run across. */
  .arow.wide {
    grid-template-columns: 18px minmax(0, 1fr) auto;
  }
  .fold-text {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .fold:hover .fold-text,
  .fold:hover .caret,
  .arow:hover .name,
  .arow:hover .ico {
    color: var(--text);
  }
  .arow.static {
    cursor: default;
  }
  .caret,
  .ico {
    color: var(--dim);
    font-family: var(--mono);
    display: inline-flex;
    align-items: center;
  }
  .name {
    font-family: var(--sans);
    color: var(--ink2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A thinking row: the name italic and dim, the spark in the accent. A
     hidden one (backlog 097) is dimmer still and no pointer. */
  .arow.thinking .name {
    font-style: italic;
    color: var(--dim);
  }
  .arow.thinking .ico {
    color: var(--accent);
    opacity: 0.7;
  }
  .arow.thinking.hidden {
    opacity: 0.7;
  }
  .arow.thinking.hidden .ico {
    color: var(--dim);
  }
  .arg {
    font-family: var(--mono);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The summary's first line (board 6, `thought · summary`): prose, not
     an argument, so the interface face in italic. */
  .arg.summary {
    font-family: var(--sans);
    font-style: italic;
    font-size: 0.78rem;
  }
  .size {
    font-family: var(--mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    min-width: 64px;
    text-align: right;
    white-space: nowrap;
    opacity: 0.8;
  }
  .arow.error .arg,
  .arow.error .size {
    color: var(--failed);
  }
  .row-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    position: relative;
    min-width: 0;
  }
  .tool-full {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--dim);
    white-space: pre-wrap;
    word-break: break-word;
    padding: 0 12px 6px 40px;
  }
  .thinking-text {
    color: var(--dim);
    font-style: italic;
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0 12px 8px 40px;
    padding-left: 0.75rem;
    border-left: 2px solid var(--border);
  }
  /* The moon, kept for the live turn (backlog 096): the same roll as the
     waiting row in `Transcript.svelte`, the elapsed time beside it; still
     dots under reduced motion. */
  .working {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: 28px;
    padding: 4px 12px;
    color: var(--dim);
    font-size: 0.78rem;
  }
  /* Inside the block the moon is a row like the others (board 1): the
     moon in the accent, `working · 41 s` in the mono beside it. Alone
     under the text it keeps its old room. */
  .activity .working .roll {
    color: var(--accent);
  }
  .working-text {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  /* The moon rolls inside a track of its own, so the text after it starts
     past the far end of the roll rather than under it (his 2026-09-16
     screenshot: the moon rolling over "working · 29 s"); it is drawn a
     size up while it rolls. */
  .roll {
    display: inline-flex;
    flex: none;
    width: 52px;
  }
  .roll :global(svg) {
    animation: roll 1.5s ease-in-out infinite alternate;
  }
  @keyframes roll {
    from {
      transform: translateX(0) rotate(0deg);
    }
    to {
      transform: translateX(32px) rotate(360deg);
    }
  }
  .dots {
    display: none;
    gap: 5px;
  }
  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.55;
  }
  @media (prefers-reduced-motion: reduce) {
    .roll {
      display: none;
    }
    .dots {
      display: inline-flex;
    }
  }
  /* The call's own hover control (backlog 066): past the row's right end,
     shown when the call is hovered or the control focused, like the turn's
     tools under the bubble. */
  .block-tools {
    position: absolute;
    right: -30px;
    top: 0;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .tool:hover .block-tools,
  .block-tools:focus-within {
    opacity: 1;
  }
  .tool-btn {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    background: var(--panel);
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--dim);
    padding: 0;
    cursor: pointer;
  }
  .tool-btn:hover,
  .tool-btn:focus-visible {
    color: var(--ink);
    border-color: var(--line2);
  }
  /* A removed block: the placeholder in the tool line's face, greyed and
     italic like a removed turn, Restore at its side. */
  .removed-block {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
  }
  .removed-original {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--dim);
  }
  .removed-original summary {
    cursor: pointer;
    list-style: none;
    opacity: 0.6;
    font-style: italic;
  }
  .removed-original summary::-webkit-details-marker {
    display: none;
  }
  .removed-body {
    margin-top: 0.3rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.6;
    font-family: var(--transcript-font, var(--sans));
    font-size: calc(var(--transcript-size, 16px) - 2px);
  }
  .removed-body.tool-chip {
    font-family: var(--mono);
    font-size: 0.78rem;
    cursor: default;
  }
  .tool-chip {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--dim);
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    min-width: 0;
  }
  .tool-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-result {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--dim);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.65rem;
    max-height: 14rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .denied-note {
    color: var(--dim);
    font-size: 0.78rem;
    word-break: break-word;
    padding: 0 12px 6px 40px;
  }
  .row-wrap > .tool-result {
    margin: 0 12px 8px 40px;
  }
  /* The interruption card (084 pass 2) keeps the block's width, in from
     its edges by the row's own padding. */
  .row-wrap > :global(.approval) {
    margin: 4px 12px 8px;
  }
  .tool-result.error {
    color: var(--failed);
    background: var(--failed-soft);
    border-color: var(--failed);
  }
  /* A notice row (a compaction, a crossing): the board's ruled amber mono
     (Handoff.dc.html) — a rule either side, the words between. */
  .notice {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--partial);
  }
  .notice::before,
  .notice::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  /* The cards under a reply (backlog 078): one row each, the composer's
     attachment chip's shape — badge · name · size · buttons — in the
     existing tokens. */
  .cards {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  /* The board's card (Cards.dc.html): 8 × 12 inside, the sheet, at most
     560 wide; the title 13.5px, a path in the mono at 12.5px. */
  .card {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: min(100%, 560px);
    min-width: 0;
    padding: 8px 12px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--sheet);
    font-size: 13.5px;
    color: var(--ink);
  }
  .card-ico {
    display: inline-flex;
    color: var(--accent);
    flex: none;
  }
  .card-ext {
    flex: none;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--bg);
    background: var(--dim);
    border-radius: 4px;
    padding: 2px 5px;
  }
  .card-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .card-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-title.mono {
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .card-sub,
  .card-size {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-size {
    flex: none;
  }
  .card .ns-btn {
    flex: none;
    gap: 4px;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .meta {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
  .meta.share {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  /* The time, after the figures, in the interface face rather than their
     mono: it is a phrase, not a number. */
  .meta.when {
    font-family: var(--sans);
    cursor: default;
  }
  .share-bar {
    display: inline-block;
    width: 56px;
    height: 4px;
    border-radius: 2px;
    background: var(--line2);
    overflow: hidden;
  }
  .share-fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }
</style>
