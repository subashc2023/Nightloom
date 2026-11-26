import { describe, expect, it } from "vitest";
import { SEND_TOOLS, isSend } from "./sendGuard";

/*
 * Nightshift item 993d, review follow-up (blockers 2304, 2346): a send's card never offers a standing allow —
 * the service never reads one for a send, so "Allow for this chat" / "Allow always" would promise nothing.
 */
describe("993d: the window's sends (a send's card offers no standing allow)", () => {
  it("names the sends as the service does", () => {
    for (const n of [
      "mcp__claude_ai_Gmail__send_message",
      "mcp__claude_ai_Gmail_2117773e__reply",
      "mcp__claude_ai_Gmail__forward",
      "mcp__claude_ai_Google_Calendar__respond_to_event",
      "mcp__claude_ai_Google_Calendar__create_event",
      "mcp__claude_ai_Google_Calendar__update_event",
      "mcp__claude_ai_Google_Calendar__delete_event",
      "mcp__claude_ai_Google_Drive__share_file",
    ])
      expect(isSend(n), n).toBe(true);
    for (const n of [
      "mcp__claude_ai_Gmail__create_draft",
      "mcp__claude_ai_Gmail__reply_later_list",
      "mcp__claude_ai_Google_Calendar__list_events",
      "mcp__nightloom__reply",
      "mcp____reply",
      "reply",
      "Bash",
    ])
      expect(isSend(n), n).toBe(false);
    expect(SEND_TOOLS.split("|")).toContain("share_file");
  });
});
