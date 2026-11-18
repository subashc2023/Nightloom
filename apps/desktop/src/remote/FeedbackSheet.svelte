<script lang="ts">
  /**
   * His feedback from the phone (nightshift item 805): the same note the
   * Mac's box sends — his words verbatim as one backlog item in the
   * Nightshift repo, with the open chat attached. The draft is kept in
   * localStorage on every keystroke (practices §7): closing the sheet,
   * opening another chat and a reload bring it back; only a send that
   * landed or a confirmed Discard clears it. A try after a lost reply
   * carries the same nonce, so it files once.
   *
   * Item 815: with a host that lists `feedback_images`, "Add a photo" and a
   * pasted screenshot attach images (thumbnails, × to remove), kept in the
   * page's IndexedDB beside the words (`feedbackImages.ts`).
   */
  import { nonceFor, type Client, type Try } from "./client";
  import { FEEDBACK_PHONE_KEY, loadPhoneFeedback, savePhoneFeedback, sentSentence } from "./feedbackDraft";
  import { afterSend } from "../lib/feedbackText";
  import { loadPhoneImages, MAX_PHONE_IMAGES, savePhoneImages, sendable, type PhoneImage } from "./feedbackImages";

  interface Props {
    client: Pick<Client, "feedback">;
    /** The host lists `feedback`. */
    available: boolean;
    /** `/api/state`'s `host`: `serve` is the away server. */
    host?: string | null;
    /** The open chat, attached to the note. */
    chat: string | null;
    chatTitle: string | null;
    project: string | null;
    onnote: (text: string) => void;
    /** The host lists `feedback_images` (item 815). */
    imagesOk?: boolean;
  }
  let { client, available, host = null, chat, chatTitle, project, onnote, imagesOk = false }: Props = $props();

  let images = $state<PhoneImage[]>([]);
  let picker = $state<HTMLInputElement | null>(null);
  void loadPhoneImages().then((kept) => {
    if (kept.length && !images.length) images = kept;
  });

  async function addFiles(files: File[]) {
    problem = null;
    for (const f of files) {
      if (images.length >= MAX_PHONE_IMAGES) {
        problem = `A note from the phone takes at most ${MAX_PHONE_IMAGES} images.`;
        break;
      }
      const img = await sendable(f);
      if (!img) {
        problem = "That image could not be read — try a screenshot or a JPEG.";
        continue;
      }
      images = [...images, img];
      done = null;
    }
    void savePhoneImages(images);
  }

  function pasted(e: ClipboardEvent) {
    if (!imagesOk) return;
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
    void addFiles(files);
  }

  function removeImage(i: number) {
    images = images.filter((_, j) => j !== i);
    void savePhoneImages(images);
  }

  let text = $state(loadPhoneFeedback());
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let done = $state<string | null>(null);
  let confirmDiscard = $state(false);
  let last: Try | null = null;
  const any = $derived(!!text.trim() || images.length > 0);

  function typed() {
    done = null;
    savePhoneFeedback(text);
  }

  async function send() {
    if (busy || !any) return;
    busy = true;
    problem = null;
    const words = text;
    const going = imagesOk ? images.slice() : [];
    const t = nonceFor(last, `${FEEDBACK_PHONE_KEY}:${words}:${going.map((i) => i.data.length).join(",")}`);
    last = t;
    try {
      const sent = await client.feedback({
        text: words,
        chat,
        chat_title: chatTitle,
        project,
        nonce: t.nonce,
        ...(going.length ? { images: going.map((i) => ({ data: i.data, kind: "paste" as const })) } : {}),
      });
      done = sentSentence(sent);
      onnote(done);
      // Only what was sent goes (review of 805): words typed and images
      // added meanwhile stay.
      text = afterSend(text, words);
      savePhoneFeedback(text);
      images = images.filter((i) => !going.includes(i));
      void savePhoneImages(images);
      last = null;
    } catch (e) {
      problem = `Not sent — ${e instanceof Error ? e.message : String(e)}. Your words are kept.`;
    } finally {
      busy = false;
    }
  }

  function discard(sure = false) {
    if (!any) return;
    if (!sure) {
      confirmDiscard = true;
      return;
    }
    text = "";
    savePhoneFeedback("");
    images = [];
    void savePhoneImages([]);
    confirmDiscard = false;
  }
</script>

<div class="fb-title">Send feedback</div>
{#if !available}
  <p class="fb-note">
    {host === "serve"
      ? "The away server has no Nightshift copy to file feedback in. Switch to the Mac in Hosts; your words are kept here."
      : "This Mac's Nightloom is older and cannot take feedback yet. Your words are kept here."}
  </p>
{:else}
  <p class="fb-note">To the agent that builds Nightloom: a new backlog item, word for word{chatTitle ? `, with “${chatTitle}” attached` : ""}.</p>
{/if}
<textarea
  class="fb-box"
  data-kept=""
  bind:value={text}
  oninput={typed}
  onpaste={pasted}
  placeholder="What should change, what broke, what you want…"
  autocapitalize="sentences"
></textarea>
{#if imagesOk}
  {#if images.length}
    <div class="fb-shots" role="list" aria-label="Attached images">
      {#each images as img, i (img)}
        <div class="fb-shot" role="listitem">
          <img src={`data:${img.type};base64,${img.data}`} alt={`Image ${i + 1}`} />
          <button class="fb-shot-x" aria-label={`Remove image ${i + 1}`} onclick={() => removeImage(i)}>×</button>
        </div>
      {/each}
    </div>
  {/if}
  <input
    bind:this={picker}
    class="fb-pick"
    type="file"
    accept="image/*"
    multiple
    onchange={(e) => {
      const input = e.currentTarget as HTMLInputElement;
      void addFiles(Array.from(input.files ?? []));
      input.value = "";
    }}
  />
{/if}
{#if problem}<p class="fb-problem" role="alert">{problem}</p>{/if}
{#if done}<p class="fb-done" role="status">{done}</p>{/if}
{#if confirmDiscard}
  <p class="fb-note">Discard this feedback? The words{images.length ? " and images" : ""} are gone after this.</p>
  <div class="fb-actions">
    <span class="fb-grow"></span>
    <button class="fb-btn" onclick={() => (confirmDiscard = false)}>Keep it</button>
    <button class="fb-btn danger" onclick={() => discard(true)}>Discard</button>
  </div>
{:else}
  <div class="fb-actions">
    <button class="fb-btn" disabled={!any} onclick={() => discard()}>Discard</button>
    {#if imagesOk}
      <button class="fb-btn" disabled={images.length >= MAX_PHONE_IMAGES} onclick={() => picker?.click()}>Add a photo</button>
    {/if}
    <span class="fb-grow"></span>
    <button class="fb-btn accent" disabled={busy || !available || !any} onclick={send}>{busy ? "Sending…" : "Send"}</button>
  </div>
{/if}

<style>
  .fb-title {
    font-weight: 600;
    font-size: 17px;
  }
  .fb-note {
    font-size: 13px;
    color: var(--dim);
    margin: 0;
    overflow-wrap: anywhere;
  }
  .fb-problem {
    font-size: 14px;
    color: var(--failed);
    margin: 0;
  }
  .fb-done {
    font-size: 14px;
    color: var(--accent-ink);
    margin: 0;
  }
  .fb-box {
    width: 100%;
    box-sizing: border-box;
    background: var(--well);
    color: inherit;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    font: inherit;
    font-size: 16px; /* under 16px iOS Safari zooms the page on focus */
    outline: none;
    min-height: 30dvh;
    resize: none;
    line-height: 1.45;
  }
  .fb-shots {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .fb-shot {
    position: relative;
    width: 72px;
    height: 72px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--line);
  }
  .fb-shot img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .fb-shot-x {
    all: unset;
    position: absolute;
    top: 2px;
    right: 2px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 16px;
    line-height: 26px;
    text-align: center;
    cursor: pointer;
  }
  .fb-pick {
    display: none;
  }
  .fb-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .fb-grow {
    flex: 1;
  }
  .fb-btn {
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
  .fb-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .fb-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .fb-btn.danger {
    color: var(--failed);
    border-color: color-mix(in srgb, var(--failed) 45%, transparent);
  }
</style>
