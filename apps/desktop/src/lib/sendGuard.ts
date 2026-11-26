/*
 * The sends (nightshift item 993d; blockers 2304, 2346): connector tools that reach other people and cannot be
 * taken back — a mail sent, replied to or forwarded, an invitation answered, an event made, changed or deleted
 * (its guests are told), a file shared. The service runs one only on his answer to that very call's card and
 * never reads a standing rule for it (`crates/nightloom-service/src/agent/send_guard.rs`, whose `SEND_TOOLS`
 * this list must equal — a Rust test reads this file). So a card for a send offers no "Allow for this chat" or
 * "Allow always": it would promise what the service will not do.
 */
export const SEND_TOOLS = "send_message|send_email|send_mail|send_draft|send|reply|reply_all|forward|respond_to_event|create_event|update_event|delete_event|share_file";

const TOOLS = new Set(SEND_TOOLS.split("|"));

/** Whether `name` (`mcp__<server>__<tool>`) is a send: by the tool's own name, on any server but Nightloom's. */
export function isSend(name: string): boolean {
  if (!name.startsWith("mcp__")) return false;
  const rest = name.slice(5);
  if (rest.startsWith("nightloom__")) return false;
  const i = rest.indexOf("__");
  if (i <= 0) return false;
  return TOOLS.has(rest.slice(i + 2));
}
