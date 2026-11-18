/**
 * The Mac's loader for the pictures under replies (item 820): the
 * `read_reply_media` command, base64 to a typed blob. Imported for its
 * effect by the reply components, so it is set before the first draw.
 */
import * as api from "./api";
import { blobOf, setMediaLoader, type Loader } from "./replyMediaStore.svelte";

export const macMediaLoader: Loader = async (path, chat) => {
  const m = await api.readReplyMedia(path, chat);
  return { kind: m.kind, mediaType: m.media_type, size: m.size, bytes: m.data === null ? null : blobOf(m.data, m.media_type) };
};

setMediaLoader(macMediaLoader);
