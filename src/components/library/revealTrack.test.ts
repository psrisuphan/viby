import { describe, expect, it, vi } from "vitest";
import { revealTrackWithFeedback } from "./revealTrack";

describe("revealTrackWithFeedback", () => {
  it("shows a track-specific error when revealing a file fails", async () => {
    const reveal = vi
      .fn()
      .mockRejectedValue(new Error("File manager unavailable"));
    const addErrorToast = vi.fn();

    await revealTrackWithFeedback(
      { id: "track-42", title: "Night Drive" },
      reveal,
      addErrorToast,
    );

    expect(reveal).toHaveBeenCalledWith("track-42");
    expect(addErrorToast).toHaveBeenCalledWith(
      "File manager unavailable",
      "error",
    );
  });

  it("does not report an error when the file manager opens", async () => {
    const reveal = vi.fn().mockResolvedValue(undefined);
    const addErrorToast = vi.fn();

    await revealTrackWithFeedback(
      { id: "track-42", title: "Night Drive" },
      reveal,
      addErrorToast,
    );

    expect(reveal).toHaveBeenCalledWith("track-42");
    expect(addErrorToast).not.toHaveBeenCalled();
  });

  it("shows a usable fallback when Windows Explorer cannot safely select a long path", async () => {
    const message =
      "This file path is too long for reliable Windows Explorer selection. Open a shorter parent folder or shorten the path, then try again.";
    const reveal = vi.fn().mockRejectedValue({ kind: "Other", message });
    const addErrorToast = vi.fn();

    await revealTrackWithFeedback(
      { id: "track-42", title: "Night Drive" },
      reveal,
      addErrorToast,
    );

    expect(addErrorToast).toHaveBeenCalledWith(message, "error");
  });
});
