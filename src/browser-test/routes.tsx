import { useEffect, useRef, useState, type ReactNode } from "react";

import { useUiStore } from "../stores/uiStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import { useSettingsStore } from "../stores/settingsStore";
import { emitBrowserTestEvent } from "../browser-shims/event";
import {
	clearBrowserTestInvocations,
	getBrowserTestInvocations,
} from "../browser-shims/core";
import { scanLibrary, showMiniPlayer, showTheaterMode } from "../utils/tauri";
import SettingsModal, { type SettingsTab } from "../components/ui/SettingsModal";
import MiniApp from "../components/player/MiniApp";
import TheaterApp from "../components/player/TheaterApp";
import AccessibleSlider from "../components/ui/AccessibleSlider";
import EqGainSlider from "../components/ui/EqGainSlider";
import { DragNumField } from "../components/ui/EqualizerTab";
import AccessibleDialog from "../components/ui/AccessibleDialog";

function ToastFocusRoute() {
	const addToast = useToastStore.getState().addToast;
	const createAndFocusToast = (
		trigger: HTMLButtonElement,
		message: string,
		type: "success" | "error",
		duration?: number,
	) => {
		trigger.focus();
		addToast(message, type, duration);
		window.requestAnimationFrame(() => {
			const closeButtons = document.querySelectorAll<HTMLButtonElement>(".toast-close");
			closeButtons.item(closeButtons.length - 1)?.focus();
		});
	};

	return (
		<section
			data-testid="t09-toast-focus-route"
			style={{
				position: "fixed",
				inset: 12,
				zIndex: 1000,
				padding: 20,
				background: "var(--bg-primary)",
				color: "var(--text-primary)",
			}}
		>
			<h1>T09 toast focus lifecycle</h1>
			<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
				<button
					type="button"
					data-testid="t09-create-timed-toast"
					onClick={(event) => createAndFocusToast(
						event.currentTarget,
						"Timed action completed",
						"success",
						8000,
					)}
				>
					Create timed toast
				</button>
				<button
					type="button"
					data-testid="t09-create-error-toast"
					onClick={(event) => createAndFocusToast(
						event.currentTarget,
						"Controlled action failed",
						"error",
					)}
				>
					Create persistent error
				</button>
				<button
					type="button"
					data-testid="t09-focus-toast-close"
					onClick={() => document.querySelector<HTMLButtonElement>(".toast-close")?.focus()}
				>
					Focus notification close
				</button>
				<button
					type="button"
					data-testid="t09-focus-away"
					onClick={(event) => event.currentTarget.focus()}
				>
					Move focus away
				</button>
				<button
					type="button"
					data-testid="t09-create-queued-toasts"
					onClick={() => {
						addToast("Announcement already active", "success", 0);
						addToast("Dismissed before announcement", "error");
					}}
				>
					Create queued notifications
				</button>
			</div>
		</section>
	);
}
import FolderManagementModal from "../components/ui/FolderManagementModal";

export interface BrowserTestRoute {
	id: string;
	aliases?: string[];
	setup?: () => void;
	renderOverlay?: (close: () => void) => ReactNode;
}

function resetUi() {
	const ui = useUiStore.getState();
	ui.setSearchOpen(false);
	ui.setQueueOpen(false);
}

function libraryRoute(id: string, view: "songs" | "albums" | "artists"): BrowserTestRoute {
	return {
		id,
		aliases: [view],
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView(view);
		},
	};
}

function scanOutcomeRoute(
	id: "scan-partial" | "scan-fatal" | "scan-no-folders",
): BrowserTestRoute {
	return {
		id,
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			window.setTimeout(() => {
				void scanLibrary().catch(() => undefined);
			}, 1200);
		},
	};
}

function settingsRoute(
	id: string,
	tab: SettingsTab,
	aliases: string[] = [],
): BrowserTestRoute {
	return {
		id,
		aliases: [`settings:${tab}`, `settings-${tab}`, ...aliases],
		setup: resetUi,
		renderOverlay: (close) => (
			<SettingsModal isOpen onClose={close} initialTab={tab} />
		),
	};
}

function SliderInteractionFixture() {
	const [value, setValue] = useState(50);
	const [disabled, setDisabled] = useState(false);
	const [mounted, setMounted] = useState(true);
	const [changes, setChanges] = useState(0);
	const [commits, setCommits] = useState(0);
	const [cancels, setCancels] = useState(0);
	const [isInteracting, setIsInteracting] = useState(false);
	const [eqValue, setEqValue] = useState(4.2);
	const [eventOrder, setEventOrder] = useState<string[]>([]);
	const eventLogRef = useRef<string[]>([]);
	const record = (event: string) => {
		eventLogRef.current.push(event);
		setEventOrder([...eventLogRef.current]);
	};

	return (
		<div className="modal-overlay" data-tauri-drag-region="false">
			<section className="modal-content" style={{ width: 520, padding: 24 }}>
				<h2>Slider interaction checks</h2>
				<div style={{ display: "flex", gap: 8 }}>
					<button type="button" onClick={() => setDisabled((current) => !current)}>
						{disabled ? "Enable slider" : "Disable slider"}
					</button>
					<button type="button" onClick={() => setMounted((current) => !current)}>
						{mounted ? "Unmount slider" : "Mount slider"}
					</button>
				</div>
				{mounted && <AccessibleSlider
					className="slider-interaction-fixture"
					value={value}
					min={0}
					max={100}
					step={1}
					pageStep={10}
					ariaLabel="Playback position test"
					ariaValueText={`${value} seconds`}
					disabled={disabled}
					getHoverValueText={(next) => `${Math.round(next)} sec`}
					onValueChange={(next) => {
						record(`change:${next}`);
						setValue(next);
						setChanges((count) => count + 1);
					}}
					onValueCommit={(next) => {
						record(`commit:${next}`);
						setCommits((count) => count + 1);
					}}
					onValueCancel={(startingValue) => {
						record(`cancel:${startingValue}`);
						setValue(startingValue);
						setCancels((count) => count + 1);
					}}
					onInteractionChange={(active) => {
						record(`interaction:${active}`);
						setIsInteracting(active);
					}}
					onDoubleClick={() => setValue(0)}
				>
					<div style={{ height: 36, background: "var(--bg-elevated)", borderRadius: 8 }}>
						<div style={{ height: "100%", width: `${value}%`, background: "var(--accent)" }} />
					</div>
				</AccessibleSlider>}
				<EqGainSlider
					value={eqValue}
					label="Disabled EQ gain test"
					disabled
					onChange={setEqValue}
				/>
				<output
					data-testid="slider-interaction-state"
					data-value={value}
					data-disabled={disabled}
					data-changes={changes}
					data-commits={commits}
					data-cancels={cancels}
					data-interacting={isInteracting}
					data-eq-value={eqValue}
					data-events={eventOrder.join("|")}
				>
					Value {value}; changes {changes}; commits {commits}; cancels {cancels}
				</output>
			</section>
		</div>
	);
}

function DragFieldOwnershipFixture() {
	const [value, setValue] = useState(50);
	const [buttonActivations, setButtonActivations] = useState(0);
	const [rowSelections, setRowSelections] = useState(0);
	const [shortcutCommands, setShortcutCommands] = useState<string[]>([]);
	useEffect(() => {
		clearBrowserTestInvocations();
		const updateCommands = () => {
			window.setTimeout(() => {
				const commands = getBrowserTestInvocations()
					.filter(({ command }) => ["next_track", "pause", "previous_track", "resume", "seek", "set_volume"].includes(command))
					.map(({ command }) => command);
				setShortcutCommands(commands);
			}, 0);
		};
		window.addEventListener("keydown", updateCommands);
		return () => window.removeEventListener("keydown", updateCommands);
	}, []);
	return (
		<div data-testid="drag-field-fixture" style={{ padding: 24 }}>
			<DragNumField
				value={value}
				min={0}
				max={100}
				step={1}
				decimals={0}
				ariaLabel="Drag field ownership"
				onCommit={setValue}
			/>
			<button
				type="button"
				data-testid="shortcut-space-button"
				onClick={() => setButtonActivations((count) => count + 1)}
			>
				Native Space activation
			</button>
			<div
				role="row"
				tabIndex={0}
				data-testid="shortcut-space-row"
				onKeyDown={(event) => {
					if (event.key !== " ") return;
					event.preventDefault();
					setRowSelections((count) => count + 1);
				}}
			>
				Space selects this row
			</div>
			<output data-testid="drag-field-value" data-value={value}>
				Value: {value}
			</output>
			<output
				data-testid="shortcut-ownership-state"
				data-button-activations={buttonActivations}
				data-row-selections={rowSelections}
				data-shortcut-commands={shortcutCommands.join(",")}
			>
				Buttons {buttonActivations}; row selections {rowSelections}; global commands {shortcutCommands.join(",") || "none"}
			</output>
		</div>
	);
}

function DialogLifecycleFixture() {
	const [parentOpen, setParentOpen] = useState(false);
	const [nestedOpen, setNestedOpen] = useState(false);
	const [firstOpen, setFirstOpen] = useState(false);
	const [secondOpen, setSecondOpen] = useState(false);
	const [tabOrderOpen, setTabOrderOpen] = useState(false);
	const [backgroundClicks, setBackgroundClicks] = useState(0);

	const closeParent = () => {
		setNestedOpen(false);
		setParentOpen(false);
	};

	return (
		<div data-testid="dialog-lifecycle-fixture" style={{ padding: 24 }}>
			<button type="button" data-testid="open-parent-dialog" onClick={() => setParentOpen(true)}>
				Open parent dialog
			</button>
			<button
				type="button"
				data-testid="open-both-dialogs"
				onClick={() => {
					setParentOpen(true);
					setNestedOpen(true);
				}}
			>
				Open parent and nested together
			</button>
			<button type="button" data-testid="open-first-dialog" onClick={() => setFirstOpen(true)}>
				Open first sibling dialog
			</button>
			<button type="button" data-testid="open-tab-order-dialog" onClick={() => setTabOrderOpen(true)}>
				Open tab order dialog
			</button>
			<button
				type="button"
				data-testid="background-action"
				onClick={() => setBackgroundClicks((count) => count + 1)}
			>
				Background action
			</button>
			<output data-testid="background-click-count" data-count={backgroundClicks}>
				Background actions: {backgroundClicks}
			</output>
			{parentOpen && (
				<AccessibleDialog
					ariaLabel="Parent lifecycle test dialog"
					overlayClassName="modal-overlay"
					contentClassName="modal-content glass-panel-heavy"
					onClose={closeParent}
				>
					<h2>Parent lifecycle test dialog</h2>
					<button type="button" data-testid="open-nested-dialog" onClick={() => setNestedOpen(true)}>
						Open nested dialog
					</button>
					<button type="button" data-testid="parent-action">Parent action</button>
					<output data-testid="parent-dialog-open">Parent is open</output>
					{nestedOpen && (
						<AccessibleDialog
							ariaLabel="Nested lifecycle test dialog"
							overlayClassName="modal-overlay"
							contentClassName="modal-content glass-panel-heavy"
							onClose={() => setNestedOpen(false)}
						>
							<h2>Nested lifecycle test dialog</h2>
							<input autoFocus data-testid="nested-autofocus" aria-label="Nested autofocus field" />
							<button type="button" data-testid="close-nested-dialog" onClick={() => setNestedOpen(false)}>
								Close nested dialog
							</button>
						</AccessibleDialog>
					)}
				</AccessibleDialog>
			)}
			{firstOpen && (
				<AccessibleDialog
					ariaLabel="First sibling lifecycle test dialog"
					overlayClassName="modal-overlay"
					contentClassName="modal-content glass-panel-heavy"
					onClose={() => setFirstOpen(false)}
				>
					<h2>First sibling lifecycle test dialog</h2>
					<button type="button" data-testid="open-second-dialog" onClick={() => setSecondOpen(true)}>
						Open second sibling dialog
					</button>
				</AccessibleDialog>
			)}
			{secondOpen && (
				<AccessibleDialog
					ariaLabel="Second sibling lifecycle test dialog"
					overlayClassName="modal-overlay"
					contentClassName="modal-content glass-panel-heavy"
					onClose={() => setSecondOpen(false)}
				>
					<h2>Second sibling lifecycle test dialog</h2>
					<button type="button" data-testid="close-first-dialog" onClick={() => setFirstOpen(false)}>
						Close first sibling dialog
					</button>
					<button type="button" data-testid="close-second-dialog" onClick={() => setSecondOpen(false)}>
						Close second sibling dialog
					</button>
				</AccessibleDialog>
			)}
			{tabOrderOpen && (
				<AccessibleDialog
					ariaLabel="Tab order lifecycle test dialog"
					overlayClassName="modal-overlay"
					contentClassName="modal-content glass-panel-heavy"
					onClose={() => setTabOrderOpen(false)}
				>
					<h2>Tab order lifecycle test dialog</h2>
					<button type="button" data-testid="requested-disabled" data-dialog-initial-focus disabled>
						Requested but disabled
					</button>
					<button type="button" data-testid="requested-hidden" data-dialog-initial-focus hidden>
						Requested but hidden
					</button>
					<button type="button" data-testid="negative-button" tabIndex={-2}>Negative tabindex</button>
					<div data-testid="negative-div" tabIndex={-2}>Negative tabindex div</div>
					<button type="button" data-testid="disabled-explicit" disabled tabIndex={0}>
						Disabled with explicit tabindex
					</button>
					<button type="button" data-testid="only-reachable">Only reachable</button>
				</AccessibleDialog>
			)}
		</div>
	);
}

export const BROWSER_TEST_ROUTES: BrowserTestRoute[] = [
	{
		id: "home",
		setup: () => {
			resetUi();
			useUiStore.getState().setActiveSection("home");
		},
	},
	{
		id: "scan-progress",
		aliases: ["scanning"],
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			useLibraryStore
				.getState()
				.setScanState(true, 60, "Scanning 12 / 20 files");
		},
	},
	{
		id: "scan-start-failure",
		aliases: ["folder-scan-start-failure"],
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			useLibraryStore
				.getState()
				.setScanState(true, 42, "Existing scan remains active");
		},
		renderOverlay: (close) => (
			<FolderManagementModal isOpen onClose={close} />
		),
	},
	{
		id: "scan-start-auto-busy",
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			useLibraryStore
				.getState()
				.setScanState(true, 42, "Existing scan remains active");
		},
	},
	scanOutcomeRoute("scan-partial"),
	scanOutcomeRoute("scan-fatal"),
	scanOutcomeRoute("scan-no-folders"),
	{
		id: "library-loading",
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			useLibraryStore.setState({
				tracks: [],
				albums: [],
				artists: [],
				playlists: [],
				isLoaded: false,
				isLoading: true,
				libraryLoadError: null,
			});
		},
	},
	{
		id: "library-error",
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			useLibraryStore.setState({
				tracks: [],
				albums: [],
				artists: [],
				playlists: [],
				isLoaded: false,
				isLoading: false,
				libraryLoadError: "Demo database error",
			});
		},
	},
	{
		id: "toast-stack",
		setup: () => {
			useToastStore.setState({ toasts: [], currentAnnouncement: null, pendingAnnouncements: [] });
			const addToast = useToastStore.getState().addToast;
			addToast('Added "Into the Blue" to queue', "success", 0);
			addToast("Playback device is unavailable", "error", 0);
			addToast("Shuffle mode enabled", "info", 0);
			addToast("Could not update the queue. Try again.", "error", 0);
			addToast("Saved playback settings", "success", 0);
			addToast("Track removed from queue", "info", 0);
		},
	},
	{
		id: "t09-toast-focus",
		setup: () => {
			resetUi();
			useToastStore.setState({ toasts: [], currentAnnouncement: null, pendingAnnouncements: [] });
		},
		renderOverlay: () => <ToastFocusRoute />,
	},
	{
		id: "slider-interactions",
		setup: resetUi,
		renderOverlay: () => <SliderInteractionFixture />,
	},
	{
		id: "dialog-lifecycle",
		setup: resetUi,
		renderOverlay: () => <DialogLifecycleFixture />,
	},
	libraryRoute("library:songs", "songs"),
	{
		id: "scan-refresh",
		setup: () => {
			resetUi();
			const ui = useUiStore.getState();
			ui.setActiveSection("library");
			ui.setActiveLibraryView("songs");
			window.setTimeout(() => {
				useLibraryStore
					.getState()
					.setScanState(true, 85, "Scanning 17 / 20 files");
				emitBrowserTestEvent("scan-progress", {
					total_files: 20,
					processed_files: 20,
					current_file: "",
					status: "complete",
					new_tracks: 1,
					changed_tracks: 0,
					removed_tracks: 0,
				});
			}, 1200);
		},
	},
	libraryRoute("library:albums", "albums"),
	libraryRoute("library:artists", "artists"),
	{
		id: "queue",
		setup: () => {
			resetUi();
			useUiStore.getState().setQueueOpen(true);
		},
	},
	{
		id: "search",
		setup: () => {
			resetUi();
			useUiStore.getState().setSearchOpen(true);
		},
	},
	{
		id: "theater",
		aliases: ["fullscreen", "fullscreen-player"],
		setup: () => {
			resetUi();
			void showTheaterMode();
		},
	},
	{
		id: "mini-player",
		aliases: ["mini"],
		setup: () => {
			resetUi();
			void showMiniPlayer();
		},
	},
	{
		// Renders the real window roots that Tauri mounts for the theater and mini windows.
		id: "window-root-theater",
		setup: resetUi,
		renderOverlay: () => <TheaterApp />,
	},
	{
		id: "window-root-mini",
		setup: resetUi,
		renderOverlay: () => <MiniApp />,
	},
	{
		id: "drag-field-ownership",
		setup: resetUi,
		renderOverlay: () => <DragFieldOwnershipFixture />,
	},
	settingsRoute("settings:general", "general"),
	settingsRoute("settings:appearance", "appearance"),
	settingsRoute("settings:equalizer", "equalizer", ["equalizer", "eq"]),
	settingsRoute("settings:storage", "storage"),
	settingsRoute("settings:shortcuts", "shortcuts"),
	settingsRoute("settings:advanced", "advanced"),
	settingsRoute("settings:about", "about"),
	{
		id: "peq",
		aliases: ["parametric-eq", "settings:peq", "settings-peq"],
		setup: () => {
			resetUi();
			const settings = useSettingsStore.getState();
			settings.setEqEnabled(true);
			settings.setEqMode("parametric");
		},
		renderOverlay: (close) => (
			<SettingsModal
				isOpen
				onClose={close}
				initialTab="equalizer"
				initialPeqExpanded
			/>
		),
	},
];

export function resolveBrowserTestRoute(location: Location): BrowserTestRoute | null {
	const params = new URLSearchParams(location.search);
	const target =
		params.get("vibyTest") ??
		params.get("component") ??
		params.get("page") ??
		params.get("route") ??
		location.hash.replace(/^#\/?/, "");

	if (!target) return null;

	const normalized = target.trim().toLowerCase();
	return (
		BROWSER_TEST_ROUTES.find(
			(route) =>
				route.id === normalized || route.aliases?.includes(normalized),
		) ?? null
	);
}
