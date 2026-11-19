// Item 845 — the tasks the stage harnesses draw (the Mac's home845 and the phone's phone845), as Home's update_task
// would write them (the shapes in tasks.rs's description).
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
// Batch 1: three tasks as Home's update_task would write them (the shapes in tasks.rs's description).
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const task = (id: string, view: string, name: string, doing: string, needs: number, data: unknown, why = "") => ({ id, view, name, doing, step: 2, of: 5, state: "live", needs, why, data, started_at: ago(20), updated_at: ago(1) });
export const homeTasks = [
  task("moving-the-review", "timeline", "Moving the design review", "Checking four calendars for today", 3, {
    day: "Wednesday, November 18", date: today,
    events: [
      { id: "stand", title: "Stand-up", start: "9:00", end: "9:30", detail: { With: "The Nightloom team (5)", Home: "Left as it is" } },
      { id: "lunch", title: "Lunch · Dana", start: "12:00", end: "13:00", detail: { Where: "Tender Greens, booked by Dana" } },
      { id: "gym", title: "Gym", start: "17:30", end: "18:30" },
    ],
    changes: [
      { id: "review", kind: "move", title: "Design review", start: "15:30", end: "16:30", was: "14:00", why: "Priya asked to move it", detail: { "Who asked": "Priya Raman, 10:38 AM", "Free / busy": "Priya, Dana and Marcus are free 3:30–4:30 PM", Undo: "Until you accept, nothing is written" } },
      { id: "focus", kind: "add", title: "Focus: item 809", start: "10:00", end: "11:30", why: "your longest free stretch before lunch" },
      { id: "priya", kind: "pick", title: "30 min with Priya", start: "16:30", end: "17:00", slots: ["11:30", "14:00", "16:30"], why: "you asked on Monday", yours: true },
    ],
  }, "find 30 min with Priya this week"),
  task("working-your-list", "todo", "Working your to-do list", "Renewing the parking permit on the city's site", 0, {
    items: [
      { id: "permit", text: "Renew the parking permit", who: "home", state: "doing", note: "overdue · city site", steps: [{ text: "Open the city's renewal page", done: true }, { text: "Fill permit RP-204418 and plate", done: true }, { text: "Hold for your OK to pay $84.00", done: false }, { text: "File the receipt", done: false }] },
      { id: "lease", text: "Decide on the lease renewal", who: "you", state: "open", note: "needs you · due Friday" },
      { id: "slides", text: "Slides for Thursday's review", who: "you", state: "open", note: "you · 40% drafted" },
      { id: "gift", text: "Order Mom's birthday gift", who: "home", state: "open", note: "Nov 24" },
      { id: "dentist", text: "Book the dentist cleaning", who: "home", state: "done", result: "Thu 4:15 PM · on your calendar", detail: { "What Home did": "Booked on the office's site; no payment" } },
    ],
  }),
  task("sorting-what-arrived", "triage", "Sorting what arrived", "Reading Mom's message", 2, {
    cards: [
      { id: "lease", from: "Landlord", title: "Lease renewal — reply by Friday", source: "gmail", pile: "needs", verdict: "A decision only you can make", question: "Renew for 12 months at $2,340, or go month to month at $2,520?", options: ["Renew 12 months", "Month to month"], todo: "Decide on the lease renewal" },
      { id: "mom", from: "Mom", title: "“Are you coming Saturday?”", source: "messages", pile: "needs", verdict: "A yes or no from you", question: "“Are you coming Saturday?” — your calendar is free after 2:00 PM.", options: ["Yes, after 2", "Can't make it"] },
      { id: "stripe", from: "Stripe", title: "Receipt #2291 · $49.00", source: "gmail", pile: "handled", verdict: "Filed under Taxes 2026" },
      { id: "ci", from: "CI", title: "nightshift · run 4183 passed", source: "ci", pile: "handled", verdict: "Told the merge chat" },
      { id: "news", from: "Stratechery", title: "This week's update", source: "gmail", pile: "later", verdict: "Reading, not action — tonight" },
      { id: "delta", from: "Delta", title: "Refund 0062381 approved", source: "gmail", pile: "inbox", reading: true },
      { id: "promo", from: "Promotions", title: "4 newsletters and offers", source: "gmail", pile: "inbox" },
    ],
  }),
  // Batch 2: Browse, Run, Research.
  task("renewing-the-permit", "browse", "Renewing the parking permit", "Reading the total before paying", 1, {
    url: "permits.cityofirvine.example/renew", site: "City of Irvine", page: "Renew a residential parking permit",
    fields: [{ label: "Permit number", value: "RP-204418" }, { label: "Licence plate", value: "8KDL402" }, { label: "Term", value: "12 months" }, { label: "Total", value: "$84.00" }],
    hold: { what: "Pay the renewal", amount: "$84.00", to: "City of Irvine", from: "the Visa ending 6411 saved on the site" },
  }, "renew my parking permit"),
  task("merge-round-t", "run", "Merge round T", "Running the code checks", 0, {
    title: "Merge round T", chat: "h-today", asks: "Quit the app when you can — the build installs then",
    steps: [
      { id: "fetch", name: "Fetch", state: "done", out: "3 branches, 41 commits" },
      { id: "merge", name: "Merge", state: "done", out: "2 clean, 1 conflict resolved", detail: { Touches: "The nightshift branch, locally" } },
      { id: "check", name: "Checks", state: "live", progress: 0.55, detail: { Does: "Formatting, lint and tests, as CI runs them" } },
      { id: "review", name: "Review", state: "wait" },
      { id: "build", name: "Build", state: "wait" },
      { id: "install", name: "Install", state: "wait", out: "waits for your quit" },
    ],
    agents: [
      { id: "merger", name: "merger", task: "wave-t-766 → nightshift", state: "done", tokens: 182 },
      { id: "checks", name: "checks", task: "clippy -p nightloom-desktop", state: "live", tokens: 61 },
    ],
    log: ["git fetch origin wave-t-766 wave-t-708", "merge wave-t-766: Auto-merging Composer.svelte", "CONFLICT (content): src/remote/Remote.svelte — resolving", "merge wave-t-708: clean", "cargo fmt --all -- --check  ·  ok", "clippy --workspace  ·  0 warnings  ·  1m 52s"],
  }, "merge round T and build it"),
  task("cache-pricing", "research", "Prompt cache pricing", "Writing the answer", 0, {
    question: "What does a 1-hour prompt cache cost against the 5-minute one, and when does it pay?",
    sources: [
      { id: "s1", site: "docs.anthropic.com", title: "Prompt caching — pricing table", state: "kept", got: "The pricing table and the two cache lifetimes" },
      { id: "s2", site: "platform.openai.com", title: "Prompt caching guide", state: "kept", got: "The caching guide, start to end" },
      { id: "s3", site: "medium.com", title: "10 tricks to cut your LLM bill", state: "dropped", why: "no figures of its own" },
      { id: "s4", site: "notes/subagent-cost-literature", title: "Your own note, 2026-09-08", state: "kept", own: true, got: "The payback section" },
    ],
    claims: [
      { id: "c1", src: "s1", text: "A 1-hour write costs 2× the base input price; a 5-minute write 1.25×; a read 0.1× either way.", quote: "“Cache writes cost 25% more (5-minute) or 2× (1-hour) the base input price.”", confidence: "high — the provider's own table" },
      { id: "c2", src: "s2", text: "OpenAI's cache is automatic and unpriced to write; there is no 1-hour option to buy." },
      { id: "c3", src: "s4", text: "Your reusable agent pays back its 1-hour write after the second follow-up inside the hour.", confidence: "high for your setup — your own measurement" },
    ],
    answer: [{ text: "A 1-hour cache costs 2× the input price to write, against 1.25× for the 5-minute one; reading either costs a tenth.", cites: ["c1"] }, { text: "So it pays as soon as one follow-up lands after minute 5 — for your reusable agent, from the second follow-up.", cites: ["c3"] }],
    open: [{ text: "Does a 1-hour read refresh the hour?", answered: "yes, by claim 1's page" }, "Gemini's storage price for the newest model"],
    confidence: "High on the prices (each provider's own page); medium on the break-even (Home's arithmetic).",
    done: true,
  }, "what does the 1-hour cache cost"),
];
