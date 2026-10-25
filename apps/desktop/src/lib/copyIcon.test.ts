import { describe, expect, it } from "vitest";
import { COPIED_MS, copyIconSvg } from "./copyIcon";
import { ICONS } from "./icons";
import assistantSrc from "./AssistantMessage.svelte?raw";
import asideCardSrc from "./AsideCard.svelte?raw";
import contextSrc from "./ContextPanel.svelte?raw";
import settingsSrc from "./SettingsModal.svelte?raw";
import codeCopySrc from "./codeCopy.ts?raw";
import copyButtonSrc from "./CopyButton.svelte?raw";
import phoneCodeSrc from "../remote/codeBlocks.ts?raw";
import phoneAsideSrc from "../remote/AsideSheet.svelte?raw";

describe("402: every Copy button is the copy icon", () => {
  it("the DOM icon is Icon.svelte's copy glyph, the check once copied, for 1.5 s", () => {
    expect(copyIconSvg(false)).toContain(ICONS.copy);
    expect(copyIconSvg(true)).toContain(ICONS.check);
    expect(copyIconSvg(false, 18)).toContain('width="18"');
    expect(copyIconSvg(false)).toContain('aria-hidden="true"');
    expect(COPIED_MS).toBe(1500);
  });

  it("the button keeps a name for a reader and the tooltip", () => {
    expect(copyButtonSrc).toContain('aria-label={copied ? "Copied" : label}');
    expect(copyButtonSrc).toContain('use:tip={copied ? "Copied" : label}');
    expect(copyButtonSrc).toContain('<Icon name={copied ? "check" : "copy"} {size} />');
  });

  it("no Copy button left with the word on it", () => {
    for (const src of [assistantSrc, asideCardSrc, contextSrc, settingsSrc, phoneAsideSrc]) {
      expect(src).not.toMatch(/"Copied" : "Copy"/);
      expect(src).not.toMatch(/>\s*Copy\s*<\/button/);
    }
    for (const src of [codeCopySrc, phoneCodeSrc]) {
      expect(src).not.toContain('textContent = "Copy"');
      expect(src).toContain("setCopyState(");
      expect(src).toContain("flashCopied(");
    }
    expect(assistantSrc).toContain("<CopyButton");
    expect(asideCardSrc).toContain("<CopyButton");
    expect(settingsSrc).toContain("<CopyButton");
    expect(contextSrc.match(/<CopyButton /g)?.length).toBe(6);
  });
});
