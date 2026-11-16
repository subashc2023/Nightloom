<script lang="ts">
  /**
   * Approval rules on the phone (nightshift item 743): what runs without
   * asking, what asks first and what is blocked — for this chat and for
   * every chat on the host — listed in the order they decide, with a form
   * to add one or change one, and Remove behind a confirm.
   *
   * Nothing typed here is lost by leaving (practices §7): the form — which
   * rule is open, every field — is the caller's (`form`, `onform`), kept
   * while the page lives, so closing the sheet and opening it again lands
   * on the same half-made rule. A removed rule is the one thing that goes,
   * and it asks first and says what those calls do next.
   */
  import { onMount } from "svelte";
  import { ACTIONS, MCP, blankForm, editOf, formOf, formProblem, formTool, grouped, matchHint, removeWords, ruleLine, scopeLabel, textLabel, type RuleEdit, type RuleForm, type RuleRow, type RulesListing } from "./rules";

  interface Props {
    /** The chat's title, or null when no chat is open (every chat's rules only). */
    title: string | null;
    /** "the Mac" or "Away": whose rules these are. */
    where: string;
    /** Why the host cannot serve this, or null. */
    missing: string | null;
    load: () => Promise<RulesListing>;
    save: (edit: RuleEdit) => Promise<RulesListing>;
    /** The form he left open, if any. */
    form: RuleForm | null;
    onform: (f: RuleForm | null) => void;
    /** The harness: a listing to show without a host. */
    initial?: RulesListing | null;
    /** The harness: open on the remove confirm for this rule. */
    confirming?: string | null;
  }
  let { title, where, missing, load, save, form, onform, initial = null, confirming = null }: Props = $props();

  // svelte-ignore state_referenced_locally
  let listing = $state<RulesListing | null>(initial);
  let problem = $state<string | null>(null);
  let busy = $state(false);
  // svelte-ignore state_referenced_locally
  let removing = $state<string | null>(confirming);

  const groups = $derived(grouped(listing?.rules ?? []));
  const tools = $derived(listing?.tools ?? []);
  const formIssue = $derived(form ? formProblem(form) : null);
  const removingRow = $derived(removing ? (listing?.rules.find((r) => r.id === removing) ?? null) : null);

  onMount(() => {
    if (missing || initial) return;
    void load().then(
      (l) => (listing = l),
      (e) => (problem = e instanceof Error ? e.message : String(e)),
    );
  });

  function set(patch: Partial<RuleForm>) {
    if (form) onform({ ...form, ...patch });
  }

  function open(row: RuleRow) {
    problem = null;
    removing = null;
    onform(form?.id === row.id ? null : formOf(row, tools));
  }

  async function run(edit: RuleEdit): Promise<boolean> {
    busy = true;
    problem = null;
    try {
      listing = await save(edit);
      return true;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      busy = false;
    }
  }

  async function submit() {
    if (!form || formIssue) return;
    // The form is dropped only once the host took it: a refusal keeps every field.
    if (await run(editOf(form))) onform(null);
  }

  async function remove(id: string) {
    if (await run({ op: "remove", id })) {
      removing = null;
      if (form?.id === id) onform(null);
    }
  }
</script>

{#snippet editor(f: RuleForm)}
  <div class="ru-form" data-rule-form={f.id ?? "new"}>
    <div class="ru-seg" role="radiogroup" aria-label="What the rule does">
      {#each ACTIONS as a (a.action)}
        <button role="radio" aria-checked={f.action === a.action} class:on={f.action === a.action} class:block={a.action === "block"} onclick={() => set({ action: a.action })}>{a.label}</button>
      {/each}
    </div>
    <small class="ru-small">{ACTIONS.find((a) => a.action === f.action)?.says}</small>
    <label class="ru-field">
      <span>Tool</span>
      <select value={f.tool} onchange={(e) => set({ tool: e.currentTarget.value })}>
        {#each tools as t (t)}<option value={t}>{t}</option>{/each}
        <option value={MCP}>A connector's tool…</option>
      </select>
    </label>
    {#if f.tool === MCP}
      <label class="ru-field">
        <span>Its name</span>
        <input type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="mcp__github__* or mcp__github__create_issue" value={f.mcp} oninput={(e) => set({ mcp: e.currentTarget.value })} />
      </label>
    {/if}
    <label class="ru-field">
      <span>Only when {textLabel(formTool(f))} has</span>
      <input type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Every call" value={f.text} oninput={(e) => set({ text: e.currentTarget.value })} />
    </label>
    <small class="ru-small">{matchHint(f.action, formTool(f))}</small>
    {#if f.id === null}
      <div class="ru-seg" role="radiogroup" aria-label="Where the rule applies">
        <button role="radio" aria-checked={f.scope === "chat"} class:on={f.scope === "chat"} disabled={!listing?.chat} onclick={() => set({ scope: "chat" })}>This chat</button>
        <button role="radio" aria-checked={f.scope === "all"} class:on={f.scope === "all"} onclick={() => set({ scope: "all" })}>Every chat</button>
      </div>
    {/if}
    {#if formIssue}<small class="ru-small">{formIssue}</small>{/if}
    <div class="ru-actions">
      {#if f.id !== null}
        <button class="ru-btn danger" disabled={busy} data-act="rule-remove" onclick={() => (removing = f.id)}>Remove</button>
      {/if}
      <span class="ru-grow"></span>
      <button class="ru-btn" disabled={busy} onclick={() => onform(null)}>Cancel</button>
      <button class="ru-btn accent" disabled={busy || !!formIssue} data-act="rule-save" onclick={submit}>{f.id === null ? "Add rule" : "Save"}</button>
    </div>
  </div>
{/snippet}

<div class="ru-title">Approval rules</div>
<div class="ru-sub">{title ? `For “${title}” and for every chat on ${where}.` : `For every chat on ${where}. Open a chat to see and make its own.`}</div>

{#if missing}
  <p class="ru-note">{missing}</p>
{:else if !listing}
  <p class="ru-note">{problem ?? "Reading the rules…"}</p>
{:else}
  {#if removingRow}
    {@const r = removingRow}
    <div class="ru-confirm" role="alertdialog" aria-label="Remove this rule?" data-rule-confirm={r.id}>
      <div class="ru-confirm-head">Remove this rule?</div>
      <div class="ru-line">{ruleLine(r)}</div>
      <p class="ru-note">{removeWords(r)}</p>
      <div class="ru-actions">
        <span class="ru-grow"></span>
        <button class="ru-btn" disabled={busy} onclick={() => (removing = null)}>Keep it</button>
        <button class="ru-btn danger" disabled={busy} data-act="rule-remove-yes" onclick={() => remove(r.id)}>Remove</button>
      </div>
    </div>
  {/if}

  {#if groups.length === 0}
    <p class="ru-note">No rules of your own yet. Every call below asks or runs by the built-in defaults.</p>
  {/if}
  {#each groups as g (g.action)}
    <div class="ru-head" data-action={g.action}>{g.head}</div>
    <div class="ru-list">
      {#each g.rows as r (r.id)}
        <button class="ru-row" class:open={form?.id === r.id} aria-expanded={form?.id === r.id} data-rule={r.id} onclick={() => open(r)}>
          <span class="ru-dot {r.action}" aria-hidden="true"></span>
          <span class="ru-grow">
            <span class="ru-line">{ruleLine(r)}</span>
            <small>{scopeLabel(r)}</small>
          </span>
          <span class="ru-edit">{form?.id === r.id ? "Close" : "Change"}</span>
        </button>
        {#if form && form.id === r.id}{@render editor(form)}{/if}
      {/each}
    </div>
  {/each}

  {#if form && form.id === null}
    <div class="ru-head">New rule</div>
    <div class="ru-list">{@render editor(form)}</div>
  {:else}
    <button class="ru-btn wide" data-act="rule-new" onclick={() => ((problem = null), (removing = null), onform(blankForm(listing?.chat ?? false)))}>Add a rule</button>
  {/if}
  {#if problem}<p class="ru-bad" role="alert">{problem}</p>{/if}

  <div class="ru-head">Built in</div>
  <ul class="ru-defaults">
    {#each listing.defaults as d (d)}<li>{d}</li>{/each}
    {#if listing.subagents_auto !== undefined}
      <li>Subagents in this chat: {listing.subagents_auto ? "their calls run without asking (Subagents run on auto is on)" : "a call that needs your approval is refused, and the main conversation makes it instead"}. Change it in Model and settings.</li>
    {/if}
    <li>A block wins over an ask, and an ask over an allow.</li>
  </ul>
{/if}

<style>
  .ru-title {
    font-weight: 600;
    font-size: 17px;
  }
  .ru-sub,
  .ru-note {
    font-size: 13px;
    color: var(--dim);
    margin: -6px 0 0;
    line-height: 1.4;
  }
  .ru-note {
    margin: 0;
  }
  .ru-head {
    font-size: 13px;
    color: var(--dim);
    margin: 4px 0 -4px;
  }
  .ru-list {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 16px;
    overflow: hidden;
    flex: none;
  }
  .ru-row {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 8px 14px;
    box-sizing: border-box;
    cursor: pointer;
  }
  .ru-row + .ru-row,
  .ru-form + .ru-row {
    border-top: 1px solid var(--line);
  }
  .ru-row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .ru-grow {
    flex: 1;
    min-width: 0;
  }
  .ru-line {
    display: block;
    font-family: var(--mono);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .ru-row small {
    display: block;
    font-size: 12px;
    color: var(--dim);
    margin-top: 2px;
  }
  .ru-edit {
    font-size: 13px;
    color: var(--dim);
    flex: none;
  }
  .ru-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    background: var(--dim);
  }
  .ru-dot.allow {
    background: var(--accent);
  }
  .ru-dot.block {
    background: var(--failed);
  }
  .ru-dot.ask {
    background: transparent;
    box-shadow: inset 0 0 0 2px var(--dim);
  }
  .ru-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px 14px;
    border-top: 1px solid var(--line);
  }
  .ru-list > .ru-form:first-child {
    border-top: 0;
  }
  .ru-seg {
    display: flex;
    gap: 6px;
  }
  .ru-seg button {
    all: unset;
    flex: 1;
    min-height: 40px;
    text-align: center;
    border-radius: 10px;
    border: 1px solid var(--line2);
    color: var(--ink2);
    cursor: pointer;
    font-size: 15px;
  }
  .ru-seg button.on {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .ru-seg button.on.block {
    border-color: var(--failed);
    background: color-mix(in srgb, var(--failed) 14%, transparent);
    color: var(--failed);
  }
  .ru-seg button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .ru-seg button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .ru-small {
    font-size: 12px;
    color: var(--dim);
    line-height: 1.4;
    margin-top: -4px;
  }
  .ru-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    color: var(--dim);
  }
  .ru-field input,
  .ru-field select {
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    background: var(--well);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 0 12px;
    /* 16px: iOS zooms the page into a smaller field on focus. */
    font: inherit;
    font-size: 16px;
  }
  /* WebKit ignores min-height on a native select: the 44 px target is its height. */
  .ru-field select {
    height: 44px;
  }
  .ru-field input {
    font-family: var(--mono);
    font-size: 16px;
  }
  .ru-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .ru-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
  }
  .ru-btn.wide {
    width: 100%;
    flex: none;
  }
  .ru-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .ru-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .ru-btn.danger {
    color: var(--failed);
    border-color: color-mix(in srgb, var(--failed) 45%, transparent);
  }
  .ru-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .ru-confirm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    border-radius: 16px;
    border: 1px solid color-mix(in srgb, var(--failed) 45%, transparent);
    background: var(--paper);
    flex: none;
  }
  .ru-confirm-head {
    font-weight: 600;
  }
  .ru-bad {
    font-size: 13px;
    color: var(--failed);
    margin: 0;
  }
  .ru-defaults {
    margin: 0;
    padding: 0 0 0 18px;
    font-size: 13px;
    color: var(--dim);
    line-height: 1.45;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
