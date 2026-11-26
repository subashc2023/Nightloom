// @vitest-environment happy-dom
/*
 * Item 993a: a reply names an event, an email or a doc in a typed tag; every reply surface draws it as a link
 * (`a.nl-ref`, its fields in `data-ref-*`) and every plain-text place shows the name alone. Read back from the
 * rendered DOM (item 980's rule), through the real renderers and DOMPurify.
 */
import { describe, expect, it } from "vitest";
import { renderInline, renderMarkdown, renderReply, streamingTail } from "./markdown";
import { openRefAt, parseRef, refFromEl, refKey, refLink, refPlain, refPlainFragment } from "./refTag";
import { plainFragment, plainLines, plainOneLine } from "./plainMd";
import { plainPreview } from "../remote/preview";
import { extractAsk } from "./askTag";
import { extractHandoff } from "./handoffTag";
import { speakable } from "./homeStage/brief";

const EVENT =
  '<event id="ev_123" src="Calendar 974e51a6" cal="primary" start="2026-11-25T12:00-08:00" end="2026-11-25T13:00-08:00" rsvp="needsAction" where="ISEB 1010" organizer="Prof. Lin" guests="14" link="https://calendar.google.com/calendar/event?eid=abc">COAST Meeting</event>';
const EMAIL =
  '<email id="m_9" thread="t_9" src="Gmail 2117773e" from="Priya S." at="2026-11-25T11:42-08:00" gist="Hi! Just confirming Dr. Okafor &quot;for sure&quot; &amp; the AV." link="https://mail.google.com/mail/u/0/#inbox/m_9">Speaker confirmation for Dec 4</email>';
const DOC = '<doc id="f_7" src="Google Drive b7e1394d" kind="doc" owner="Priya S." edited="2026-11-24T21:10-08:00" link="https://docs.google.com/document/d/f_7/edit">Fall Speaker Series — run of show</doc>';

function dom(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
}

describe("993a: the tag drawn as a link", () => {
  it("an event, an email and a doc each become a.nl-ref with their fields, through DOMPurify", () => {
    const d = dom(renderReply(`You haven't responded to ${EVENT} at 12 PM.\n\n**Club mail:** ${EMAIL} is waiting.\n\n- She linked ${DOC}.`));
    const links = [...d.querySelectorAll<HTMLElement>("a.nl-ref")];
    expect(links.map((a) => a.textContent)).toEqual(["COAST Meeting", "Speaker confirmation for Dec 4", "Fall Speaker Series — run of show"]);
    expect(links.map((a) => a.dataset.refKind)).toEqual(["event", "email", "doc"]);
    const ev = links[0];
    expect(ev.dataset.refId).toBe("ev_123");
    expect(ev.dataset.refSrc).toBe("Calendar 974e51a6");
    expect(ev.dataset.refStart).toBe("2026-11-25T12:00-08:00");
    expect(ev.dataset.refRsvp).toBe("needsAction");
    expect(ev.dataset.refWhere).toBe("ISEB 1010");
    expect(ev.dataset.refLink).toBe("https://calendar.google.com/calendar/event?eid=abc");
    // No href: the link router never takes it; it is a button to the keyboard.
    expect(ev.hasAttribute("href")).toBe(false);
    expect(ev.getAttribute("role")).toBe("button");
    expect(ev.getAttribute("tabindex")).toBe("0");
    // Entities in a value are read, then carried safely.
    expect(links[1].dataset.refGist).toBe('Hi! Just confirming Dr. Okafor "for sure" & the AV.');
    // A doc's `kind` is its type (the element's own kind stays "doc").
    expect(links[2].dataset.refType).toBe("doc");
    // No raw tag text anywhere.
    expect(d.textContent).not.toMatch(/<event|<email|<doc|id=/);
    expect(d.textContent).toContain("You haven't responded to COAST Meeting at 12 PM.");
  });

  it("the card reads the link back whole", () => {
    const a = dom(renderReply(EVENT)).querySelector("a.nl-ref");
    const r = refFromEl(a);
    expect(r).toMatchObject({ kind: "event", id: "ev_123", src: "Calendar 974e51a6", name: "COAST Meeting" });
    expect(r?.fields).toMatchObject({ cal: "primary", rsvp: "needsAction", where: "ISEB 1010", organizer: "Prof. Lin", guests: "14" });
    expect(refKey(r!)).toBe("event:Calendar 974e51a6:ev_123");
    expect(parseRef(EVENT)).toEqual(r);
  });

  it("a tag at the start of a paragraph, of a list item, inside bold and in a table cell is still a link", () => {
    const d = dom(renderReply(`${EVENT} is at noon.\n\n- ${DOC}\n- **${EMAIL}**\n\n| What | When |\n|---|---|\n| ${EVENT} | 12 PM |`));
    expect(d.querySelectorAll("a.nl-ref").length).toBe(4);
    expect(d.querySelector("strong a.nl-ref")?.textContent).toBe("Speaker confirmation for Dec 4");
    expect(d.querySelector("td a.nl-ref")?.textContent).toBe("COAST Meeting");
  });

  it("without an id or a source, or of an unknown kind, the name is plain words", () => {
    const d = dom(renderReply('See <event src="Calendar 1">No Id</event>, <email id="m1">No Source</email>, <event id="" src="x">Empty Id</event> and <task id="1" src="x">Not A Kind</task>.'));
    expect(d.querySelector("a.nl-ref")).toBeNull();
    expect(d.textContent).toContain("See No Id, No Source, Empty Id and Not A Kind.");
  });

  it("inside inline code and a code fence a tag is text", () => {
    const d = dom(renderReply("The tag is `" + EVENT + "`.\n\n```\n" + DOC + "\n```"));
    expect(d.querySelector("a.nl-ref")).toBeNull();
    // (Under happy-dom DOMPurify drops the element that opens the string, so the paragraph itself is not asked for.)
    expect(d.querySelector("code")?.textContent).toBe(EVENT);
    expect(d.querySelector("pre code")?.textContent).toContain('<doc id="f_7"');
  });

  it("nothing in a tag is trusted: markup is escaped, unknown attributes dropped, the link held to Google's hosts", () => {
    const evil =
      '<event id="e1" src="Calendar 1" onclick="alert(1)" style="color:red" where="&lt;img src=x onerror=alert(1)&gt;" link="https://evil.example/calendar">A &lt;b&gt;bold&lt;/b&gt; name</event>';
    const d = dom(renderReply(evil));
    const a = d.querySelector<HTMLElement>("a.nl-ref")!;
    expect(a).not.toBeNull();
    expect(d.querySelector("img, b, script")).toBeNull();
    expect(a.hasAttribute("onclick")).toBe(false);
    expect(a.hasAttribute("style")).toBe(false);
    expect(a.dataset.refLink).toBeUndefined();
    expect(a.dataset.refWhere).toBe("<img src=x onerror=alert(1)>");
    expect(a.textContent).toBe("A <b>bold</b> name");
    for (const bad of ["http://calendar.google.com/x", "javascript:alert(1)", "https://calendar.google.com.evil.io/x", "https://user@docs.google.com/x", "https://www.google.com/search?q=x", "https://docs.google.com:8443/x", "file:///etc/passwd", ""])
      expect(refLink(bad)).toBeNull();
    for (const ok of ["https://calendar.google.com/calendar/u/0/r", "https://mail.google.com/mail/u/0/", "https://docs.google.com/document/d/1/edit", "https://drive.google.com/file/d/1/view", "https://www.google.com/calendar/event?eid=abc"])
      expect(refLink(ok)).toBe(ok);
  });

  it("a reply that writes the <a> itself as raw HTML cannot smuggle a link or a field past the card", () => {
    const d = dom(renderReply('<a class="nl-ref" data-ref-kind="event" data-ref-id="e1" data-ref-src="Calendar 1" data-ref-link="https://evil.example/x" data-ref-bogus="1">Fake</a> and <a class="nl-ref" data-ref-kind="event" data-ref-src="Calendar 1">No id</a>'));
    const [a, b] = [...d.querySelectorAll("a.nl-ref")];
    const r = refFromEl(a);
    expect(r?.fields.link).toBeUndefined();
    expect(r?.fields.bogus).toBeUndefined();
    expect(refFromEl(b)).toBeNull();
    expect(refFromEl(d.querySelector("p"))).toBeNull();
  });

  it("the phone's renderer draws the same link; a note and a Home row keep the name and no raw tag", () => {
    const phone = dom(renderMarkdown(`Next: ${EVENT}`, { breaks: true, localImagesAsText: true }));
    expect(phone.querySelector("a.nl-ref")?.textContent).toBe("COAST Meeting");
    const note = dom(renderMarkdown(`Next: ${EVENT}`));
    expect(note.querySelector("a.nl-ref")).toBeNull();
    expect(note.textContent).toBe("Next: COAST Meeting\n");
    const row = dom(renderInline(`**Calendar:** ${EVENT}`));
    expect(row.textContent).toBe("Calendar: COAST Meeting");
  });
});

describe("993a: a half tag never shows while a reply streams", () => {
  it("an opener still arriving is held back; the link appears when the tag closes", () => {
    const whole = `You have ${EVENT} at 12 PM.`;
    const open = whole.indexOf("<event");
    const close = whole.indexOf("</event>") + "</event>".length;
    for (let n = 0; n <= whole.length; n++) {
      const d = dom(renderReply(streamingTail(whole.slice(0, n))));
      // Never a raw piece of the tag, at any length.
      expect(d.textContent, `at ${n}`).not.toMatch(/<|id=|src=|event>|"$/);
      if (n > open && n < close) {
        expect(d.querySelector("a.nl-ref"), `at ${n}`).toBeNull();
        expect(d.textContent?.trim(), `at ${n}`).toBe("You have");
      }
      if (n >= close) expect(d.querySelector("a.nl-ref")?.textContent, `at ${n}`).toBe("COAST Meeting");
    }
  });

  it("openRefAt: an opener, half an opener, a closed tag, one inside open code", () => {
    expect(openRefAt('See <event id="1" src="x">COAST')).toBe(4);
    expect(openRefAt("See <ev")).toBe(4);
    expect(openRefAt("See <")).toBe(4);
    expect(openRefAt("See <email")).toBe(4);
    expect(openRefAt("See <do")).toBe(4);
    expect(openRefAt(`See ${DOC} and`)).toBe(-1);
    expect(openRefAt(`See ${DOC} and <email id="2"`)).toBe(`See ${DOC} and `.length);
    expect(openRefAt("an <events> tag")).toBe(-1);
    expect(openRefAt("x < y and <b>")).toBe(-1);
    expect(openRefAt('the tag `<event id="1"')).toBe(-1);
  });
});

describe("993a: plain-text places show the name alone", () => {
  const reply = `You have ${EVENT} at 12 PM and **${EMAIL}** from Priya.`;
  const plain = "You have COAST Meeting at 12 PM and Speaker confirmation for Dec 4 from Priya.";

  it("refPlain: names for tags, code left exactly as written", () => {
    expect(refPlain(`You have ${EVENT} at 12 PM.`)).toBe("You have COAST Meeting at 12 PM.");
    expect(refPlain("The tag is `" + EVENT + "` and " + DOC)).toBe("The tag is `" + EVENT + "` and Fall Speaker Series — run of show");
    expect(refPlain("```\n" + EVENT + "\n```\n" + EVENT)).toBe("```\n" + EVENT + "\n```\nCOAST Meeting");
    expect(refPlain("no tags here < or > there")).toBe("no tags here < or > there");
  });

  it("a chat's name, a navigator line, an aside's label and the phone's long-press preview", () => {
    expect(plainLines(reply)).toBe(plain);
    expect(plainOneLine(reply)).toBe(plain);
    expect(plainPreview(reply)).toBe(plain);
  });

  it("a search snippet, cut anywhere through a tag", () => {
    expect(plainFragment(`before ${EVENT} after`)).toBe("before COAST Meeting after");
    const at = reply.indexOf("COAST");
    // The hit is the name: the piece before ends inside the opener, the piece after starts at the closer.
    expect(plainFragment(reply.slice(0, at))).toBe("You have ");
    expect(plainFragment(reply.slice(at + "COAST Meeting".length, at + 40))).not.toMatch(/[<>]|event/);
    // A piece that starts inside an opener's attributes.
    expect(refPlainFragment('="ISEB 1010">COAST Meeting</event> at 12 PM')).toBe("COAST Meeting at 12 PM");
    expect(refPlainFragment("a > b and c < d")).toBe("a > b and c < d");
  });

  it("a question for him: the box, the card and the Needs-you row get names", () => {
    const ask = extractAsk(`<ask>\nAccept ${EVENT}?\n- Yes, accept ${EVENT}\n- No\n</ask>`);
    expect(ask).toEqual({ question: "Accept COAST Meeting?", options: ["Yes, accept COAST Meeting", "No"] });
    const d = dom(renderReply(`<ask>\nAccept ${EVENT}?\n- Yes\n- No\n</ask>`));
    expect(d.querySelector(".nl-ask-q")?.textContent).toBe("Accept COAST Meeting?");
  });

  it("the hand-off card shows names; the next chat's prompt keeps the tags", () => {
    const text = `<handoff>\nFollow up on ${EVENT}.\n</handoff>`;
    const d = dom(renderReply(text));
    expect(d.querySelector(".handoff-text")?.textContent).toBe("Follow up on COAST Meeting.");
    expect(extractHandoff(text)).toBe(`Follow up on ${EVENT}.`);
  });

  it("read aloud", () => {
    expect(speakable(`- ${EVENT} at noon`)).toBe("COAST Meeting at noon");
  });
});
