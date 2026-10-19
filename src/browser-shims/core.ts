import type {
  Playlist,
  ScanProgress,
  SearchResults,
  TopArtist,
} from "../types";

type InvokeArgs = Record<string, unknown> | undefined;

export interface BrowserInvokeRecord {
  command: string;
  args?: InvokeArgs;
}

interface BrowserTestIpcState {
  invocations: BrowserInvokeRecord[];
  failNext: { command: string; message: string } | null;
}

interface BrowserTestWindow extends Window {
  __vibyBrowserTestIpc?: BrowserTestIpcState;
}

const serverIpcState: BrowserTestIpcState = { invocations: [], failNext: null };

function browserTestIpcState(): BrowserTestIpcState {
  if (typeof window === "undefined") return serverIpcState;
  const testWindow = window as BrowserTestWindow;
  if (!testWindow.__vibyBrowserTestIpc) {
    testWindow.__vibyBrowserTestIpc = { invocations: [], failNext: null };
  }
  return testWindow.__vibyBrowserTestIpc;
}

export function getBrowserInvokeLog(): BrowserInvokeRecord[] {
  return [...browserTestIpcState().invocations];
}

export function clearBrowserInvokeLog(): void {
  browserTestIpcState().invocations.length = 0;
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("viby-test-invoke"));
}

export function failNextBrowserInvoke(command: string, message: string): void {
  browserTestIpcState().failNext = { command, message };
}

import {
  mockTracks,
  mockAlbums,
  mockArtists,
  mockTargetCurves,
  mockHeadphoneMeasurements,
  mockQueue,
  mockPlaybackState,
  applyMockPlaybackCommand,
} from "./mocks";
import { dispatchMockEvent, emitBrowserTestEvent } from "./event";
import { browserTestTrace } from "./testTrace";

const browserSearch =
  typeof window === "undefined" ? "" : window.location.search;
const browserTestIpcScenario = new URLSearchParams(browserSearch).get(
  "ipcScenario",
);
const browserTestRoute = new URLSearchParams(browserSearch).get("route");
let getAllTracksCalls = 0;

function waitForBrowserTestIpc(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 3000));
}

const noopResults = {
  get_all_tracks: mockTracks,
  get_albums: mockAlbums,
  get_artists: mockArtists,
  get_playlists: [] as Playlist[],
  get_genres: ["Synthwave", "Acoustic", "Electronic", "Lofi", "Ambient"],
  get_recently_played: mockTracks.slice(0, 3),
  get_recently_added_tracks: mockTracks,
  get_top_artists_played: [
    {
      name: "Neon Horizons",
      play_count: 12,
      artwork_track_id: "track-1",
      artwork_album: "Midnight Boulevard",
      artwork_album_artist: "Neon Horizons",
    },
  ] as TopArtist[],
  get_target_curves: mockTargetCurves,
  get_headphone_measurements: mockHeadphoneMeasurements,
  get_queue: mockQueue,
  get_playback_state: mockPlaybackState,
  get_background_app_status: {
    enabled: false,
    supported: false,
    provider: "unsupported" as const,
    permission: "not-required" as const,
  },
  get_gpu_acceleration: true,
  is_kde_desktop: false,
  is_gnome_desktop: false,
  search: {
    tracks: mockTracks,
    albums: mockAlbums,
    artists: mockArtists,
  } as SearchResults,
  get_track_artwork: null,
  run_autoeq: { bands: [], preamp: 0, loss: 0, maxResponseDb: 0 },
  import_target_curve: { name: "", points: [] as [number, number][] },
  import_headphone_measurement: { name: "", points: [] as [number, number][] },
  create_playlist: {
    id: "browser-test",
    name: "",
    track_count: 0,
    created_at: "",
    updated_at: "",
  },
  get_album_tracks: mockTracks,
  get_playlist_tracks: mockTracks,
  get_library_folders: [] as string[],
  pick_library_folders: [] as string[],
};

export async function invoke<T = unknown>(
  command: string,
  _args?: InvokeArgs,
): Promise<T> {
  const testIpc = browserTestIpcState();
  testIpc.invocations.push({ command, args: _args });
  if (testIpc.invocations.length > 200) testIpc.invocations.shift();
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("viby-test-invoke"));
  if (testIpc.failNext?.command === command) {
    const failure = testIpc.failNext;
    testIpc.failNext = null;
    throw new Error(failure.message);
  }
  if (applyMockPlaybackCommand(command, _args)) {
    browserTestTrace.invokes.push(command);
    dispatchMockEvent("playback-state", mockPlaybackState);
    if (
      ["set_shuffle", "toggle_shuffle", "set_repeat", "cycle_repeat"].includes(
        command,
      )
    ) {
      dispatchMockEvent("queue-changed", mockQueue);
    }
    return undefined as T;
  }
  if (
    command === "clear_history" &&
    browserTestIpcScenario === "reject-clear-history"
  ) {
    throw new Error("Controlled clear-history failure");
  }

  if (command === "leave_theater_mode" || command === "leave_mini_player") {
    if (browserTestIpcScenario === "reject-mode-exit") {
      throw { kind: "Other", message: "Mode exit failed in browser test" };
    }
    if (browserTestIpcScenario === "delay-mode-exit") {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return undefined as T;
  }

  browserTestTrace.invokes.push(command);
  if (command === "scan_library") {
    if (
      browserTestIpcScenario === "scan-start-busy" ||
      browserTestIpcScenario === "scan-start-auto-busy"
    ) {
      throw { kind: "ScanBusy" };
    }
    if (browserTestIpcScenario === "scan-start-ipc-failure") {
      throw { kind: "Transport", message: "Controlled scan IPC failure" };
    }
    const isPartial =
      browserTestIpcScenario === "partial-auto-scan" ||
      browserTestRoute === "scan-partial";
    const isFailure =
      browserTestIpcScenario === "fail-auto-scan" ||
      browserTestRoute === "scan-fatal";
    const isNoFolders = browserTestRoute === "scan-no-folders";
    const result: ScanProgress = {
      total_files: isNoFolders ? 0 : isPartial || isFailure ? 3 : 8,
      processed_files: isNoFolders ? 0 : isPartial || isFailure ? 3 : 8,
      current_file: "",
      status: isFailure ? "error" : "complete",
      new_tracks: isPartial || isFailure ? 1 : 0,
      changed_tracks: 0,
      removed_tracks: 0,
      skipped_files: isPartial ? 1 : 0,
      failed_folders: isPartial ? 1 : 0,
      partial_success: isPartial,
      error: isFailure ? "Database pruning failed" : null,
      error_details_truncated: false,
      root_outcomes_truncated: false,
      message: isNoFolders
        ? "No library folders configured. Add a folder first."
        : undefined,
      total_tracks: isNoFolders ? 0 : undefined,
      folder_errors: isPartial
        ? [{ path: "/offline/music", error: "unavailable root" }]
        : [],
      file_errors: isPartial
        ? [{ path: "/music/bad.mp3", error: "unsupported file" }]
        : [],
      root_outcomes: isPartial
        ? [
            {
              path: "/offline/music",
              status: "error",
              discovered_files: 0,
              skipped_files: 0,
              protected_empty_subtrees: 0,
              pruning_skipped: true,
              error: "unavailable root",
            },
            {
              path: "/music",
              status: "partial",
              discovered_files: 2,
              skipped_files: 1,
              protected_empty_subtrees: 0,
              pruning_skipped: true,
              error:
                "1 file(s) failed metadata extraction; stale tracks were retained for this root",
            },
          ]
        : isFailure
          ? [
              {
                path: "/music",
                status: "aborted",
                discovered_files: 3,
                skipped_files: 0,
                protected_empty_subtrees: 0,
                pruning_skipped: true,
                error: "Database pruning failed",
              },
            ]
          : [],
    };
    emitBrowserTestEvent("scan-progress", result);
    emitBrowserTestEvent("scan-complete", result);
    if (isFailure) throw new Error(result.error ?? "Controlled scan failure");
    return result as T;
  }

  if (command === "get_all_tracks") {
    const call = getAllTracksCalls++;
    if (
      (browserTestIpcScenario === "delay-first-load" && call === 0) ||
      (browserTestIpcScenario === "delay-scan-refresh" && call === 1)
    ) {
      await waitForBrowserTestIpc();
    }
    if (browserTestIpcScenario === "fail-first-load" && call === 0) {
      throw new Error("Controlled browser-test library load failure");
    }
    if (
      (browserTestIpcScenario === "partial-auto-scan" ||
        browserTestRoute === "scan-partial" ||
        browserTestRoute === "scan-fatal") &&
      call > 0
    ) {
      return [
        {
          ...mockTracks[0],
          title:
            browserTestRoute === "scan-fatal"
              ? "Refreshed after failed scan"
              : "Refreshed after partial scan",
        },
        ...mockTracks.slice(1),
      ] as T;
    }
  }

  if (command === "calculate_eq_response") {
    const request = _args?.request as { frequencies?: number[] } | undefined;
    return (request?.frequencies?.map(() => 0) ?? []) as T;
  }

  switch (command) {
    case "get_all_tracks":
    case "get_albums":
    case "get_artists":
    case "get_playlists":
    case "get_genres":
    case "get_recently_played":
    case "get_recently_added_tracks":
    case "get_top_artists_played":
    case "get_target_curves":
    case "get_headphone_measurements":
    case "get_queue":
    case "get_playback_state":
    case "get_background_app_status":
    case "get_gpu_acceleration":
    case "is_kde_desktop":
    case "is_gnome_desktop":
    case "search":
    case "get_track_artwork":
    case "run_autoeq":
    case "import_target_curve":
    case "import_headphone_measurement":
    case "create_playlist":
    case "get_album_tracks":
    case "get_playlist_tracks":
    case "pick_library_folders":
      return noopResults[command as keyof typeof noopResults] as T;
    case "get_library_folders":
      return ["/music"] as T;
    case "reveal_track_in_folder":
      throw new Error("File reveal is unavailable in browser test mode");
    default:
      return undefined as T;
  }
}
