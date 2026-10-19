import { describe, expect, it } from "vitest";
import {
  getModifierLabel,
  getSeekTarget,
  isEditableTarget,
  resolveGlobalShortcut,
  shouldFocusLibraryFilter,
} from "./shortcuts";

function keyEvent(overrides: Partial<KeyboardEvent> = {}) {
  return {
    key: "k",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    target: null,
    ...overrides,
  } as KeyboardEvent;
}

describe("keyboard shortcut routing", () => {
  it("routes global search through the platform modifier", () => {
    expect(resolveGlobalShortcut(keyEvent(), false)).toEqual({
      type: "toggleSearch",
    });
    expect(
      resolveGlobalShortcut(keyEvent({ ctrlKey: false, metaKey: true }), true),
    ).toEqual({
      type: "toggleSearch",
    });
  });

  it("does not intercept shortcuts in text editors", () => {
    const targets = [{ tagName: "TEXTAREA" }, { isContentEditable: true }].map(
      (target) => target as unknown as EventTarget,
    );

    for (const target of targets) {
      expect(resolveGlobalShortcut(keyEvent({ target }), false)).toBeNull();
      expect(
        resolveGlobalShortcut(keyEvent({ key: " ", target }), false),
      ).toBeNull();
    }
  });

  it("keeps local slash search out of editable controls and IME composition", () => {
    const body = { tagName: "BODY" } as unknown as EventTarget;
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    const editor = { isContentEditable: true } as unknown as EventTarget;

    expect(shouldFocusLibraryFilter("/", body)).toBe(true);
    expect(shouldFocusLibraryFilter("/", input)).toBe(false);
    expect(shouldFocusLibraryFilter("/", editor)).toBe(false);
    expect(shouldFocusLibraryFilter("/", body, true)).toBe(false);
    expect(isEditableTarget(input)).toBe(true);
  });

  it("routes five-second seek shortcuts and clamps their destination", () => {
    expect(
      resolveGlobalShortcut(
        keyEvent({ key: "ArrowRight", shiftKey: true }),
        false,
      ),
    ).toEqual({
      type: "seek",
      direction: 1,
    });
    expect(
      resolveGlobalShortcut(
        keyEvent({ key: "ArrowLeft", shiftKey: true }),
        false,
      ),
    ).toEqual({
      type: "seek",
      direction: -1,
    });
    expect(getSeekTarget(42, 224, 1)).toBe(47);
    expect(getSeekTarget(2, 224, -1)).toBe(0);
    expect(getSeekTarget(222, 224, 1)).toBe(224);
  });

  it("keeps existing next and previous shortcuts distinct from seek", () => {
    expect(
      resolveGlobalShortcut(
        keyEvent({ key: "ArrowRight", shiftKey: false }),
        false,
      ),
    ).toEqual({
      type: "nextTrack",
    });
    expect(
      resolveGlobalShortcut(
        keyEvent({ key: "ArrowLeft", shiftKey: false }),
        false,
      ),
    ).toEqual({
      type: "previousOrRestart",
    });
  });

  it("uses matching modifier labels in tooltips and help", () => {
    expect(getModifierLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(
      "⌘",
    );
    expect(getModifierLabel("Mozilla/5.0 (Windows NT 10.0)")).toBe("Ctrl");
  });
});
