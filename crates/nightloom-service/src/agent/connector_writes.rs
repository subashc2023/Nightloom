//! Connector tools that write or send, refused in a read-only chat
//! (nightshift item 759).
//!
//! The Chat policy's matcher ([`super::CHAT_POLICY_MATCHER`]) lets every
//! `mcp__` tool through, and a born Chat's `--tools` list does not narrow
//! MCP tools at all — so a read-only chat or job could send mail, share a
//! Drive file or create a calendar event through his claude.ai connectors
//! (or any MCP server his settings load). Here: one more `PreToolUse` deny
//! entry in the one `--settings` JSON, on [`MATCHER`], beside the policy's
//! own. By hook, like the policy, so the tool list and the cached prefix
//! stay what they were.
//!
//! **Default-closed by verb.** A connector tool is a read when its name
//! (the part after the server's `__`) starts with one of [`READ_VERBS`]
//! — `get_message`, `list_events`, `search_files`, `read_doc`, `query`,
//! Notion's `notion-search`, the IDE's `getDiagnostics` — and a write
//! otherwise. A deny-list of today's writers would drift open on the next
//! connector (the reason [`super::READ_ONLY_TOOLS`] is a positive list); an
//! unknown tool here is refused, and the model reads why. Nightloom's own
//! server is named tool by tool instead ([`NIGHTLOOM_WRITES`]), and the
//! browser's and Playwright's tools keep their own entries.
//!
//! The matcher is a JavaScript pattern (the CLI's; negative lookaheads the
//! `regex` crate cannot compile). [`writes`] is the same rule in Rust, and
//! the tests run the pattern through `node` against [`TABLE`] so the two
//! cannot drift.

/// The verbs a read starts with, `|`-joined, for the patterns below.
macro_rules! read_verbs {
    () => {
        "get|list|search|read|query|fetch|find|download|suggest|guide|lookup|describe|view|count|show|browse"
    };
}

/// Nightloom's own server's writes (`mcp_server.rs`): the note organisers
/// (item 472) and the note editor's rename (item 460). The preview is the
/// policy's own entry ([`super::PREVIEW_TOOL_MATCHER`]). And Home's
/// Reminders writer (item 872), which only Home's read-only chat asks
/// about ([`HOME_GATED_MATCHER`]) and every other refuses.
macro_rules! nightloom_writes {
    () => {
        "move_notes|make_note_folder|rename_note|update_reminders"
    };
}

/// What follows `mcp__` in a connector write: Nightloom's named writes, or
/// any other server's tool (not the browser's, not Playwright's) whose
/// name does not start with a read verb. The tool's name may carry one
/// hyphenated product word first (`notion-search`); a verb ends at `_`,
/// `-`, a capital (`getDiagnostics`) or the name's end.
macro_rules! write_body {
    () => {
        concat!(
            "nightloom__(?:",
            nightloom_writes!(),
            ")$|(?!nightloom__|claude-in-chrome__|playwright__)(?:(?!__).)+__(?!(?:[a-z0-9]+-)?(?:",
            read_verbs!(),
            ")(?:[_A-Z-]|$))"
        )
    };
}

/// The verbs a known writer starts with (item 783's finish, the parent's
/// decision on the builder's open point): a connector action under one of
/// these is refused in a read-only chat as before 759's card, never asked
/// about — the card is for a verb on neither list. From the connectors his
/// sessions list (Gmail, Drive, Calendar, Docs, Sheets, Claude Docs,
/// Notion, scheduled tasks, the IDE; `inferred` for the rest).
macro_rules! write_verbs {
    () => {
        "send|reply|forward|trash|untrash|delete|remove|create|update|edit|modify|patch|set|add|append|insert|write|upload|share|unshare|move|copy|duplicate|rename|label|unlabel|apply|mark|unmark|archive|unarchive|respond|accept|decline|invite|cancel|schedule|book|run|execute|exec|post|publish|submit|batch|export|import|clear|empty|purge|merge|close|reopen|assign|comment|approve|reject|pay|transfer|purchase|buy|order|subscribe|unsubscribe|restore|save|draft|sync|start|stop|enable|disable|grant|revoke|lock|unlock|pin|unpin|star|unstar|snooze|resolve|complete|replace|put|push|deploy|install|uninstall|kill|reset|toggle"
    };
}

/// What follows `mcp__` in a known connector write: Nightloom's named
/// writes, or another server's tool that is not a read ([`write_body`]'s
/// rule) and whose name starts with one of [`WRITE_VERBS`] (after one
/// optional product word, as the reads).
macro_rules! known_write_body {
    () => {
        concat!(
            "nightloom__(?:",
            nightloom_writes!(),
            ")$|(?!nightloom__|claude-in-chrome__|playwright__)(?:(?!__).)+__(?!(?:[a-z0-9]+-)?(?:",
            read_verbs!(),
            ")(?:[_A-Z-]|$))(?:[a-z0-9]+-)?(?:",
            write_verbs!(),
            ")(?:[_A-Z-]|$)"
        )
    };
}

/// What follows `mcp__` in a call a read-only chat *asks him about*
/// instead of refusing (item 783): a connector action that is neither a
/// known read nor a known write (blocker 2033), and Nightloom's `remember`
/// (blocker 2032).
macro_rules! card_body {
    () => {
        concat!(
            "nightloom__remember$|(?!nightloom__|claude-in-chrome__|playwright__)(?:(?!__).)+__(?!(?:[a-z0-9]+-)?(?:",
            read_verbs!(),
            ")(?:[_A-Z-]|$))(?!(?:[a-z0-9]+-)?(?:",
            write_verbs!(),
            ")(?:[_A-Z-]|$))"
        )
    };
}

/// Home's gated writers (item 845; 846 §5 #3, §7 step 5): the mail and
/// calendar actions Home's views propose — label, archive (a label off),
/// draft; an event made, moved or answered — on a server whose name says
/// Gmail or Calendar. In Home's read-only chat each asks him on a card,
/// once per call (Allow once / Deny / Not now; never Allow always), where
/// every other chat refuses them. Sending mail stays refused everywhere.
macro_rules! home_gated_tools {
    () => {
        "label_message|label_thread|unlabel_message|unlabel_thread|update_message_labels|create_draft|update_draft|create_event|update_event|respond_to_event"
    };
}

/// The server part of a gated writer's name: one holding Gmail or Calendar.
macro_rules! home_gated_server {
    () => {
        "(?:(?!__).)*(?:[Gg]mail|[Cc]alendar)(?:(?!__).)*__"
    };
}

/// Nightloom's own gated writer (item 872): Home's Reminders tool
/// ([`crate::home::reminders::TOOL`]), asked about on the same card.
macro_rules! home_gated_own {
    () => {
        "nightloom__update_reminders"
    };
}

/// What follows `mcp__` in a gated writer's name: a gated tool on a Gmail
/// or Calendar server, or Nightloom's own Reminders writer.
macro_rules! home_gated_body {
    () => {
        concat!(
            "(?:",
            home_gated_server!(),
            "(?:",
            home_gated_tools!(),
            ")|",
            home_gated_own!(),
            ")$"
        )
    };
}

/// The gated writers' asking entry's matcher, served only in Home's
/// read-only chat (`AgentSpec::home_gated_writes`).
pub const HOME_GATED_MATCHER: &str = concat!("^mcp__", home_gated_body!());

/// [`KNOWN_WRITES_MATCHER`] less the gated writers, for Home's read-only
/// chat — one call never meets the refusal and the card both.
pub const KNOWN_WRITES_MATCHER_HOME: &str = concat!(
    "^mcp__(?!",
    home_gated_body!(),
    ")(?:",
    known_write_body!(),
    ".*)"
);

/// Nightloom's own gated writer, as the CLI names it after `mcp__`.
pub const HOME_GATED_OWN: &str = home_gated_own!();

/// Nightloom's own gated writer, whole — the refusal's matcher where a
/// chat of Home's is not held read-only (`AgentSpec::home_chat`).
pub const HOME_OWN_WRITER_MATCHER: &str = concat!("^mcp__", home_gated_own!(), "$");

/// What the model reads there. No `'` (single-quoted for the shell) and
/// none of `cmd`'s `&|<>^%`.
pub const HOME_OWN_WRITER_UNHELD: &str = "Reminders was not changed: Home changes it only from its read-only chat, where each change waits for his tap on a card. This chat is not held read-only, so no card can ask.";

/// The gated tools, as words.
pub const HOME_GATED_TOOLS: &str = home_gated_tools!();

/// Whether `name` is one of Home's gated writers — [`HOME_GATED_MATCHER`]
/// in Rust.
pub fn home_gated(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("mcp__") else {
        return false;
    };
    if rest == HOME_GATED_OWN {
        return true;
    }
    let Some(i) = rest.find("__") else {
        return false;
    };
    let server = rest[..i].to_ascii_lowercase();
    let tool = &rest[i + 2..];
    (server.contains("gmail") || server.contains("calendar"))
        && HOME_GATED_TOOLS.split('|').any(|t| t == tool)
}

/// Nightloom's `remember`, by its own name.
pub const REMEMBER: &str = "remember";

/// The matcher of the read-only chat's asking entry (item 783): the hook
/// with [`super::ask::READ_ONLY_ARG`] decides these — a card, not a
/// refusal. Registered only where a card can show (a chat with the Ask
/// hook); elsewhere [`MATCHER`]'s refusal stands as before.
pub const CARD_MATCHER: &str = concat!("^mcp__(?:", card_body!(), ".*)");

/// The known writes — Nightloom's own and every connector action under a
/// write verb — refused in a read-only chat whether or not a card can
/// show: the part of [`MATCHER`] [`CARD_MATCHER`] does not take.
pub const KNOWN_WRITES_MATCHER: &str = concat!("^mcp__(?:", known_write_body!(), ".*)");

/// [`ASK_EXCLUSION`] with `remember` — what the Ask hook's own `mcp__`
/// alternative leaves out where [`CARD_MATCHER`] is registered, so one
/// call never meets two deciders.
pub const ASK_EXCLUSION_WITH_CARD: &str = concat!("nightloom__remember$|", write_body!());

/// The write verbs, as words.
pub const WRITE_VERBS: &str = write_verbs!();

/// Whether `name` is a known write — [`KNOWN_WRITES_MATCHER`] in Rust:
/// Nightloom's own, or a connector action that is not a read and starts
/// with a write verb.
pub fn known_write(name: &str) -> bool {
    if !writes(name) {
        return false;
    }
    let Some(rest) = name.strip_prefix("mcp__") else {
        return false;
    };
    if rest.starts_with("nightloom__") {
        return true;
    }
    let Some(i) = rest.find("__") else {
        return false;
    };
    let tool = &rest[i + 2..];
    starts_with(WRITE_VERBS, tool)
        || product_word(tool).is_some_and(|t| starts_with(WRITE_VERBS, t))
}

/// Whether a read-only chat asks about `name` by verb — neither a read
/// nor a known write (the same rule as [`CARD_MATCHER`], `remember` aside).
pub fn asks(name: &str) -> bool {
    writes(name) && !known_write(name)
}

/// The read verbs, as words.
pub const READ_VERBS: &str = read_verbs!();

/// Nightloom's own server's writes, as words.
pub const NIGHTLOOM_WRITES: &str = nightloom_writes!();

/// The deny entry's `PreToolUse` matcher. Ends in `.*` on the open branch
/// so it reads the same whether the CLI tests the pattern or matches it
/// whole.
pub const MATCHER: &str = concat!("^mcp__(?:", write_body!(), ".*)");

/// [`MATCHER`]'s body after `mcp__`, for the Ask hook's own `mcp__`
/// lookahead (`super::ASK_MCP_LESS_*`): a call the deny already refused
/// must not also raise an approval card (backlog 147's bug).
pub const ASK_EXCLUSION: &str = write_body!();

/// What the model reads when a read-only chat refuses a connector write.
/// No `'` (single-quoted for the shell) and none of `cmd`'s `&|<>^%`.
pub const REASON: &str = "This chat is a Chat: connector tools that send, create, change or delete (mail, files, calendars, documents) are withdrawn with the other tools that act. Their reads, search and the web remain.";

/// Whether `name` is a tool [`MATCHER`] refuses — the same rule in Rust.
pub fn writes(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("mcp__") else {
        return false;
    };
    if let Some(tool) = rest.strip_prefix("nightloom__") {
        return NIGHTLOOM_WRITES.split('|').any(|w| w == tool);
    }
    if rest.starts_with("claude-in-chrome__") || rest.starts_with("playwright__") {
        return false;
    }
    let Some(i) = rest.find("__") else {
        return false;
    };
    if i == 0 {
        return false;
    }
    let tool = &rest[i + 2..];
    !(starts_with_read(tool) || product_word(tool).is_some_and(starts_with_read))
}

/// `tool` after a leading `[a-z0-9]+-`, if it has one.
fn product_word(tool: &str) -> Option<&str> {
    let i = tool.find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))?;
    (i > 0 && tool[i..].starts_with('-')).then(|| &tool[i + 1..])
}

fn starts_with_read(tool: &str) -> bool {
    starts_with(READ_VERBS, tool)
}

/// Whether `tool` starts with one of `verbs` (`|`-joined) as a whole word:
/// followed by `_`, `-`, a capital or the end.
fn starts_with(verbs: &str, tool: &str) -> bool {
    verbs.split('|').any(|v| {
        tool.strip_prefix(v).is_some_and(|after| {
            after.is_empty()
                || after.starts_with(['_', '-'])
                || after.starts_with(|c: char| c.is_ascii_uppercase())
        })
    })
}

/// Read or write, as the classification table says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Read,
    Write,
}

/// The classification table (item 759): every connector family's tools as
/// the CLI names them, each read or write. Tool names from the connectors
/// his Claude sessions list (`inferred` for the server prefixes beyond
/// `connectors.rs`'s measured Drive and Docs). `export` (Claude Docs) is
/// a write: it may make a file in his Drive, and nothing here says it
/// does not. The downloads are reads: they bring content in and change
/// nothing in his account.
pub const TABLE: &[(&str, &str, Class)] = {
    use Class::{Read as R, Write as W};
    &[
        // Gmail
        ("Gmail", "mcp__claude_ai_Gmail__send_message", W),
        ("Gmail", "mcp__claude_ai_Gmail__create_draft", W),
        ("Gmail", "mcp__claude_ai_Gmail__update_draft", W),
        ("Gmail", "mcp__claude_ai_Gmail__delete_draft", W),
        ("Gmail", "mcp__claude_ai_Gmail__reply", W),
        ("Gmail", "mcp__claude_ai_Gmail__forward", W),
        ("Gmail", "mcp__claude_ai_Gmail__create_label", W),
        ("Gmail", "mcp__claude_ai_Gmail__update_label", W),
        ("Gmail", "mcp__claude_ai_Gmail__delete_label", W),
        ("Gmail", "mcp__claude_ai_Gmail__label_message", W),
        ("Gmail", "mcp__claude_ai_Gmail__unlabel_message", W),
        ("Gmail", "mcp__claude_ai_Gmail__label_thread", W),
        ("Gmail", "mcp__claude_ai_Gmail__unlabel_thread", W),
        ("Gmail", "mcp__claude_ai_Gmail__update_message_labels", W),
        (
            "Gmail",
            "mcp__claude_ai_Gmail__apply_sensitive_message_label",
            W,
        ),
        (
            "Gmail",
            "mcp__claude_ai_Gmail__apply_sensitive_thread_label",
            W,
        ),
        ("Gmail", "mcp__claude_ai_Gmail__mark_message_spam", W),
        ("Gmail", "mcp__claude_ai_Gmail__unmark_thread_spam", W),
        ("Gmail", "mcp__claude_ai_Gmail__trash_message", W),
        ("Gmail", "mcp__claude_ai_Gmail__trash_thread", W),
        ("Gmail", "mcp__claude_ai_Gmail__untrash_message", W),
        ("Gmail", "mcp__claude_ai_Gmail__get_message", R),
        ("Gmail", "mcp__claude_ai_Gmail__get_thread", R),
        ("Gmail", "mcp__claude_ai_Gmail__get_draft", R),
        ("Gmail", "mcp__claude_ai_Gmail__list_drafts", R),
        ("Gmail", "mcp__claude_ai_Gmail__list_labels", R),
        ("Gmail", "mcp__claude_ai_Gmail__search_threads", R),
        (
            "Gmail",
            "mcp__claude_ai_Gmail__download_gmail_attachment",
            R,
        ),
        // Google Drive
        ("Drive", "mcp__claude_ai_Google_Drive__create_file", W),
        ("Drive", "mcp__claude_ai_Google_Drive__update_file", W),
        ("Drive", "mcp__claude_ai_Google_Drive__copy_file", W),
        ("Drive", "mcp__claude_ai_Google_Drive__share_file", W),
        ("Drive", "mcp__claude_ai_Google_Drive__trash_file", W),
        ("Drive", "mcp__claude_ai_Google_Drive__search_files", R),
        ("Drive", "mcp__claude_ai_Google_Drive__read_file_content", R),
        (
            "Drive",
            "mcp__claude_ai_Google_Drive__download_file_content",
            R,
        ),
        ("Drive", "mcp__claude_ai_Google_Drive__get_file_metadata", R),
        (
            "Drive",
            "mcp__claude_ai_Google_Drive__get_file_permissions",
            R,
        ),
        ("Drive", "mcp__claude_ai_Google_Drive__list_recent_files", R),
        (
            "Drive",
            "mcp__claude_ai_Google_Drive__list_file_revisions",
            R,
        ),
        (
            "Drive",
            "mcp__claude_ai_Google_Drive__list_shared_drives",
            R,
        ),
        // Google Calendar
        (
            "Calendar",
            "mcp__claude_ai_Google_Calendar__create_event",
            W,
        ),
        (
            "Calendar",
            "mcp__claude_ai_Google_Calendar__update_event",
            W,
        ),
        (
            "Calendar",
            "mcp__claude_ai_Google_Calendar__delete_event",
            W,
        ),
        (
            "Calendar",
            "mcp__claude_ai_Google_Calendar__respond_to_event",
            W,
        ),
        ("Calendar", "mcp__claude_ai_Google_Calendar__get_event", R),
        ("Calendar", "mcp__claude_ai_Google_Calendar__list_events", R),
        (
            "Calendar",
            "mcp__claude_ai_Google_Calendar__list_calendars",
            R,
        ),
        (
            "Calendar",
            "mcp__claude_ai_Google_Calendar__search_events",
            R,
        ),
        (
            "Calendar",
            "mcp__claude_ai_Google_Calendar__suggest_time",
            R,
        ),
        // Google Docs
        ("Docs", "mcp__claude_ai_Google_Docs__update_doc", W),
        ("Docs", "mcp__claude_ai_Google_Docs__read_doc", R),
        // Google Sheets
        ("Sheets", "mcp__claude_ai_Google_Sheets__update_values", W),
        ("Sheets", "mcp__claude_ai_Google_Sheets__update_formulas", W),
        (
            "Sheets",
            "mcp__claude_ai_Google_Sheets__update_spreadsheet",
            W,
        ),
        ("Sheets", "mcp__claude_ai_Google_Sheets__append_values", W),
        (
            "Sheets",
            "mcp__claude_ai_Google_Sheets__batch_clear_values",
            W,
        ),
        (
            "Sheets",
            "mcp__claude_ai_Google_Sheets__insert_dimension",
            W,
        ),
        (
            "Sheets",
            "mcp__claude_ai_Google_Sheets__copy_sheet_to_another_spreadsheet",
            W,
        ),
        ("Sheets", "mcp__claude_ai_Google_Sheets__get_spreadsheet", R),
        ("Sheets", "mcp__claude_ai_Google_Sheets__get_values", R),
        // Claude Docs
        ("Claude Docs", "mcp__claude_ai_Claude_Docs__batch", W),
        ("Claude Docs", "mcp__claude_ai_Claude_Docs__create", W),
        ("Claude Docs", "mcp__claude_ai_Claude_Docs__update", W),
        ("Claude Docs", "mcp__claude_ai_Claude_Docs__delete", W),
        ("Claude Docs", "mcp__claude_ai_Claude_Docs__export", W),
        ("Claude Docs", "mcp__claude_ai_Claude_Docs__read", R),
        ("Claude Docs", "mcp__claude_ai_Claude_Docs__query", R),
        ("Claude Docs", "mcp__claude_ai_Claude_Docs__guide", R),
        // A connector under an opaque server id, as some hosts name them
        (
            "Opaque id",
            "mcp__2117773e-1eb9-41d3-b80c-93e38c29d7ba__send_message",
            W,
        ),
        (
            "Opaque id",
            "mcp__2117773e-1eb9-41d3-b80c-93e38c29d7ba__get_message",
            R,
        ),
        // Other servers his settings may load
        (
            "Scheduled tasks",
            "mcp__scheduled-tasks__create_scheduled_task",
            W,
        ),
        (
            "Scheduled tasks",
            "mcp__scheduled-tasks__run_scheduled_task",
            W,
        ),
        (
            "Scheduled tasks",
            "mcp__scheduled-tasks__list_scheduled_tasks",
            R,
        ),
        ("Notion", "mcp__claude_ai_Notion__notion-create-pages", W),
        ("Notion", "mcp__claude_ai_Notion__notion-update-page", W),
        ("Notion", "mcp__claude_ai_Notion__notion-search", R),
        ("Notion", "mcp__claude_ai_Notion__notion-fetch", R),
        ("IDE", "mcp__ide__executeCode", W),
        ("IDE", "mcp__ide__getDiagnostics", R),
        ("OpenAlex", "mcp__openalex__search_works", R),
        ("OpenAlex", "mcp__openalex__get_citations", R),
        ("Unknown verb", "mcp__someserver__frobnicate", W),
        // Nightloom's own server
        ("Nightloom", "mcp__nightloom__move_notes", W),
        ("Nightloom", "mcp__nightloom__make_note_folder", W),
        ("Nightloom", "mcp__nightloom__rename_note", W),
        // Home's Reminders writer (item 872): refused everywhere but Home's
        // read-only chat, which asks about it on a card.
        ("Nightloom", "mcp__nightloom__update_reminders", W),
        ("Nightloom", "mcp__nightloom__search_chats", R),
        ("Nightloom", "mcp__nightloom__read_chat", R),
        ("Nightloom", "mcp__nightloom__remember", R),
        ("Nightloom", "mcp__nightloom__fetch_page", R),
        ("Nightloom", "mcp__nightloom__context_status", R),
        ("Nightloom", "mcp__nightloom__memory_where", R),
        ("Nightloom", "mcp__nightloom__notion_search", R),
        ("Nightloom", "mcp__nightloom__notion_read_page", R),
        ("Nightloom", "mcp__nightloom__list_notes", R),
        ("Nightloom", "mcp__nightloom__send_file", R),
        ("Nightloom", "mcp__nightloom__mark_file", R),
        ("Nightloom", "mcp__nightloom__set_budget", R),
        ("Nightloom", "mcp__nightloom__send_feedback", R),
        ("Nightloom", "mcp__nightloom__generate_image", R),
        ("Nightloom", "mcp__nightloom__ask", R),
        // Their own entries, not this one's
        ("Own entries", "mcp__nightloom__preview", R),
        ("Own entries", "mcp__nightloom__add_folder", R),
        ("Own entries", "mcp__nightloom__request_secret", R),
        ("Own entries", "mcp__nightloom__ask_user_to_drive", R),
        ("Own entries", "mcp__claude-in-chrome__navigate", R),
        ("Own entries", "mcp__playwright__browser_click", R),
        // Not MCP: the policy's and the tool list's business
        ("Built-in", "Bash", R),
        ("Built-in", "Read", R),
    ]
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Every family in the table, each with at least one write and one
    /// read where the family has both, classified as the table says.
    fn family_holds(family: &str) {
        let rows: Vec<_> = TABLE.iter().filter(|(f, _, _)| *f == family).collect();
        assert!(!rows.is_empty(), "{family}");
        for (_, name, class) in rows {
            assert_eq!(writes(name), *class == Class::Write, "{family}: {name}");
        }
    }

    #[test]
    fn gmail_sends_drafts_labels_and_trash_are_refused_its_reads_pass() {
        family_holds("Gmail");
    }

    #[test]
    fn drive_create_update_copy_share_and_trash_are_refused_its_reads_pass() {
        family_holds("Drive");
    }

    #[test]
    fn calendar_create_update_delete_and_respond_are_refused_its_reads_pass() {
        family_holds("Calendar");
    }

    #[test]
    fn docs_and_sheets_writes_are_refused_their_reads_pass() {
        family_holds("Docs");
        family_holds("Sheets");
        family_holds("Claude Docs");
    }

    #[test]
    fn nightlooms_own_note_writes_are_refused_its_other_tools_pass() {
        family_holds("Nightloom");
        family_holds("Own entries");
    }

    #[test]
    fn other_servers_and_unknown_verbs_are_default_closed() {
        for f in [
            "Opaque id",
            "Scheduled tasks",
            "Notion",
            "IDE",
            "OpenAlex",
            "Unknown verb",
            "Built-in",
        ] {
            family_holds(f);
        }
    }

    /// The JavaScript pattern the CLI reads, run through `node` over the
    /// whole table (and the Ask hook's exclusion beside it): it must agree
    /// with [`writes`] on every row. Skipped, loudly, where `node` is not
    /// on the PATH.
    #[test]
    fn the_cli_pattern_agrees_with_the_table_in_javascript() {
        let names: Vec<&str> = TABLE.iter().map(|(_, n, _)| *n).collect();
        let script = format!(
            "const m=new RegExp({m});const a=new RegExp({a});const n={n};\
             console.log(JSON.stringify(n.map(x=>[m.test(x),a.test(x)])));",
            m = serde_json::to_string(MATCHER).unwrap(),
            a = serde_json::to_string(&format!("^mcp__(?!{ASK_EXCLUSION}).*")).unwrap(),
            n = serde_json::to_string(&names).unwrap(),
        );
        let out = match std::process::Command::new("node")
            .arg("-e")
            .arg(&script)
            .output()
        {
            Ok(o) if o.status.success() => o,
            Ok(o) => panic!("node failed: {}", String::from_utf8_lossy(&o.stderr)),
            Err(e) => {
                eprintln!("SKIPPED: node not runnable here ({e})");
                return;
            }
        };
        let got: Vec<(bool, bool)> = serde_json::from_slice(&out.stdout).unwrap();
        for ((_, name, class), (refused, asks)) in TABLE.iter().zip(got) {
            let w = *class == Class::Write;
            assert_eq!(refused, w, "matcher on {name}");
            // The Ask hook's `mcp__` alternative leaves out exactly the
            // refused ones (non-MCP names never match it).
            assert_eq!(asks, name.starts_with("mcp__") && !w, "ask on {name}");
        }
    }

    /// Item 845: in Home's read-only chat the gated mail and calendar
    /// writers leave the refusal for their own card, and nothing else moves:
    /// sending, trashing, deleting stay refused; reads stay reads. Run
    /// through `node` like the CLI's own pattern, and against [`home_gated`].
    #[test]
    fn homes_gated_writers_ask_and_every_other_write_stays_refused() {
        let mut names: Vec<&str> = TABLE.iter().map(|(_, n, _)| *n).collect();
        let extra = [
            "mcp__claude_ai_Google_Calendar__update_event",
            "mcp__claude_ai_Google_Calendar__respond_to_event",
            "mcp__claude_ai_Google_Calendar__delete_event",
            "mcp__claude_ai_Gmail__label_messages_everywhere",
            "mcp__claude_ai_Drive__create_event",
            "mcp__nightloom__move_notes",
            "mcp__nightloom__update_reminders_too",
            "mcp__nightloom__update_task",
        ];
        names.extend(extra);
        for n in &names {
            let gated = home_gated(n);
            if gated {
                assert!(
                    known_write(n),
                    "a gated writer is a known write elsewhere: {n}"
                );
            }
        }
        assert!(home_gated("mcp__claude_ai_Gmail__label_message"));
        // Item 872: Nightloom's own Reminders writer, and nothing else of
        // Nightloom's.
        assert!(home_gated("mcp__nightloom__update_reminders"));
        assert!(!home_gated("mcp__nightloom__update_reminders_too"));
        assert!(!home_gated("mcp__nightloom__update_task"));
        assert!(!home_gated("mcp__other__nightloom__update_reminders"));
        assert!(!home_gated("mcp__nightloom__move_notes"));
        assert!(home_gated("mcp__claude_ai_Google_Calendar__update_event"));
        assert!(!home_gated("mcp__claude_ai_Gmail__send_message"));
        assert!(!home_gated(
            "mcp__claude_ai_Gmail__label_messages_everywhere"
        ));
        assert!(!home_gated("mcp__claude_ai_Drive__create_event"));
        assert!(!home_gated("mcp__claude_ai_Google_Calendar__delete_event"));
        let script = format!(
            "const g=new RegExp({g});const k=new RegExp({k});const n={n};\
             console.log(JSON.stringify(n.map(x=>[g.test(x),k.test(x)])));",
            g = serde_json::to_string(HOME_GATED_MATCHER).unwrap(),
            k = serde_json::to_string(KNOWN_WRITES_MATCHER_HOME).unwrap(),
            n = serde_json::to_string(&names).unwrap(),
        );
        let out = match std::process::Command::new("node")
            .arg("-e")
            .arg(&script)
            .output()
        {
            Ok(o) if o.status.success() => o,
            Ok(o) => panic!("node failed: {}", String::from_utf8_lossy(&o.stderr)),
            Err(e) => {
                eprintln!("SKIPPED: node not runnable here ({e})");
                return;
            }
        };
        let got: Vec<(bool, bool)> = serde_json::from_slice(&out.stdout).unwrap();
        let mut gated_seen = 0;
        for (name, (gated, refused)) in names.iter().zip(got) {
            assert_eq!(gated, home_gated(name), "gated matcher on {name}");
            assert_eq!(
                refused,
                known_write(name) && !gated,
                "Home's refusal on {name}"
            );
            gated_seen += usize::from(gated);
        }
        assert!(
            gated_seen >= 10,
            "the table's Gmail and Calendar writers: {gated_seen}"
        );
    }

    /// Item 783's finish: every write the table names is a *known* write
    /// (refused in a read-only chat as before), and only a verb on neither
    /// list — `frobnicate` — is asked about. A product word in front does
    /// not hide either, and a read verb wins over a write word after it.
    #[test]
    fn known_writers_are_refused_and_only_a_verb_on_neither_list_is_asked_about() {
        for (family, name, class) in TABLE {
            let unknown = *family == "Unknown verb";
            let w = *class == Class::Write;
            assert_eq!(known_write(name), w && !unknown, "known write: {name}");
            assert_eq!(asks(name), unknown, "asks: {name}");
        }
        for name in [
            "mcp__claude_ai_Acme__inspect_record",
            "mcp__claude_ai_Acme__frobnicate",
            "mcp__claude_ai_Acme__settle",
            "mcp__claude_ai_Acme__reports",
        ] {
            assert!(asks(name) && !known_write(name), "{name}");
        }
        for name in [
            "mcp__claude_ai_Acme__send_invoice",
            "mcp__claude_ai_Acme__acme-delete-thing",
            "mcp__claude_ai_Acme__uploadFile",
            "mcp__claude_ai_Acme__move",
        ] {
            assert!(known_write(name) && !asks(name), "{name}");
        }
        // A read stays a read: `update-search_x` reads (product word, read verb).
        assert!(!writes("mcp__claude_ai_Acme__update-search_x"));
        assert!(!known_write("mcp__claude_ai_Acme__update-search_x"));
    }

    /// [`KNOWN_WRITES_MATCHER`] and [`CARD_MATCHER`] in JavaScript, as the
    /// CLI reads them: they agree with [`known_write`] and [`asks`] on the
    /// whole table and a few more, and never both match one call.
    #[test]
    fn the_known_writes_and_card_patterns_agree_with_rust_in_javascript() {
        let mut names: Vec<&str> = TABLE.iter().map(|(_, n, _)| *n).collect();
        names.extend([
            "mcp__claude_ai_Acme__inspect_record",
            "mcp__claude_ai_Acme__acme-delete-thing",
            "mcp__claude_ai_Acme__uploadFile",
            "mcp__claude_ai_Acme__update-search_x",
            "mcp__claude_ai_Acme__settle",
        ]);
        let script = format!(
            "const k=new RegExp({k});const c=new RegExp({c});const n={n};\
             console.log(JSON.stringify(n.map(x=>[k.test(x),c.test(x)])));",
            k = serde_json::to_string(KNOWN_WRITES_MATCHER).unwrap(),
            c = serde_json::to_string(CARD_MATCHER).unwrap(),
            n = serde_json::to_string(&names).unwrap(),
        );
        let out = match std::process::Command::new("node")
            .arg("-e")
            .arg(&script)
            .output()
        {
            Ok(o) if o.status.success() => o,
            Ok(o) => panic!("node failed: {}", String::from_utf8_lossy(&o.stderr)),
            Err(e) => {
                eprintln!("SKIPPED: node not runnable here ({e})");
                return;
            }
        };
        let got: Vec<(bool, bool)> = serde_json::from_slice(&out.stdout).unwrap();
        for (name, (refused, card)) in names.iter().zip(got) {
            assert_eq!(refused, known_write(name), "known writes on {name}");
            let remember = *name == "mcp__nightloom__remember";
            assert_eq!(card, asks(name) || remember, "card on {name}");
            assert!(!(refused && card), "both on {name}");
        }
    }

    #[test]
    fn the_reason_survives_both_shells() {
        assert!(!REASON.contains(['\'', '&', '|', '<', '>', '^', '%']));
        assert!(!MATCHER.contains('\''));
    }
}
