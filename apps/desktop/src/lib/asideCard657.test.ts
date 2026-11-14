import { describe, expect, it } from "vitest";
import topBar from "./TopBar.svelte?raw";
import rightRail from "./RightRail.svelte?raw";
import providerRail from "./ProviderRail.svelte?raw";
import composer from "./Composer.svelte?raw";
import { displayName } from "./modelSeen";

/**
 * Item 657 (his "the aside * subscription button doesn't do anything in the
 * aside page", then "which on the normal chat is like the list of
 * settings"): the aside tab's chip opens the chat's settings card — the
 * same component in the same place — scoped to the aside.
 */
const chip = (() => {
  const a = topBar.indexOf('class="ns-chip model aside-kind"');
  return topBar.slice(topBar.lastIndexOf("<", a), topBar.indexOf("</button>", a));
})();

describe("657: the aside chip opens the settings card", () => {
  it("is a button that toggles the card, anchored as the chat's chip", () => {
    expect(chip.startsWith("<button")).toBe(true);
    expect(chip).toMatch(/onclick=\{toggleAsideCard\}/);
    expect(chip).toMatch(/aria-expanded=\{showAsideCard\}/);
    expect(chip).toMatch(/bind:this=\{chipEl\}/);
  });

  it("opens the same popover with the same RightRail, given the aside", () => {
    expect(topBar).toMatch(/\{#if aside \? showAsideCard : app\.showRail\}\s*<!--[\s\S]*?-->\s*<div\s+class="popover hud-m"/);
    expect(topBar).toMatch(/<RightRail \{aside\} \{asideChat\} \/>/);
    // Its own flag: the chat bar's card does not open with it.
    expect(topBar).toMatch(/if \(aside \? !showAsideCard : !app\.showRail\) return;\n\s+placePop\(\);/);
  });

  it("the card's ProviderRail is the aside's; no Tasks tab for an aside", () => {
    expect(rightRail).toMatch(/<ProviderRail \{aside\} \{asideChat\} \/>/);
    expect(rightRail).toMatch(/aside \? TABS\.filter\(\(t\) => t\.id !== "tasks"\) : TABS/);
  });

  it("model and effort are the aside's own; every other row is the chat's, disabled", () => {
    expect(providerRail).toMatch(/aria-label="This aside's model"/);
    expect(providerRail).toMatch(/aria-label="This aside's effort"/);
    expect(providerRail).toMatch(/onclick=\{\(\) => pickAside\("model", r\.pick\)\}/);
    expect(providerRail).toMatch(/onclick=\{\(\) => pickAside\("effort", e\)\}/);
    const opens = providerRail.match(/<fieldset class="chat-own" disabled=\{!!aside\}>/g) ?? [];
    const closes = providerRail.match(/<\/fieldset>/g) ?? [];
    expect(opens.length).toBe(2);
    expect(closes.length).toBe(2);
    // The chat's own model pills and its effort segment are inside the
    // chat-owned part or replaced: the aside branch comes first.
    expect(providerRail).toMatch(/\{#if aside\}\s*<!-- Item 657: the aside's own model/);
    expect(providerRail).toMatch(/\.chat-own \{\s*display: contents;/);
  });

  it("the aside composer's model button names the model, not its id", () => {
    expect(composer).toMatch(/const asideModelLabel = \$derived\(aside\?\.model \? displayName\(aside\.model\)/);
    expect(composer).toMatch(/const chatModelName = \$derived\(app\.draft\.agentModel\.trim\(\) \? displayName\(app\.draft\.agentModel\) : "default"\)/);
    expect(displayName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(displayName("opus")).toBe("opus");
  });

  it("the chip's tip names the model, not its id", () => {
    expect(chip).toMatch(/af\?\.model \? displayName\(af\.model\)/);
  });
});
