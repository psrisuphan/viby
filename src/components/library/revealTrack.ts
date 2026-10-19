import type { Track } from "../../types";
import { formatInvokeError } from "../../utils/errorMessage";

export async function revealTrackWithFeedback(
  track: Pick<Track, "id" | "title">,
  reveal: (trackId: string) => Promise<void>,
  addErrorToast: (message: string, type: "error") => void,
): Promise<void> {
  try {
    await reveal(track.id);
  } catch (error) {
    addErrorToast(
      formatInvokeError(
        error,
        `Couldn't reveal "${track.title}" in its folder`,
      ),
      "error",
    );
  }
}
