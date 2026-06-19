import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { getName, getVersion } from "@tauri-apps/api/app";
import {
	X,
	Trash2,
	Database,
	Image,
	CheckCircle2,
	Info,
	Settings,
	HardDrive,
	Sliders,
	FlaskConical,
	ChevronLeft,
	ChevronRight,
	Palette,
	Keyboard,
	MessageSquare,
	Activity,
	Cpu,
	CircleHelp,
} from "lucide-react";
import { getProfileLogs, clearProfileLogs, subscribeToProfiler, setIgnoreRenders } from "../../utils/profiler";
import {
	clearPlayHistory,
	setVolume as setRustVolume,
} from "../../utils/tauri";
import { clearArtworkCache, getArtworkCacheSize } from "../../utils/useArtwork";
import { useToastStore } from "../../stores/toastStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePlayerStore } from "../../stores/playerStore";
import EqualizerTab from "./EqualizerTab";
import PeqPresetControls from "./PeqPresetControls";
import ThemePicker from "./ThemePicker";
import CustomScrollbar from "./CustomScrollbar";
import Logo from "./Logo";
import "./SettingsModal.css";

type Tab = "general" | "appearance" | "equalizer" | "storage" | "shortcuts" | "advanced" | "about" | "profiler";

interface NavItem {
	id: Tab;
	label: string;
	icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
	{ id: "general", label: "General", icon: <Settings size={16} /> },
	{ id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
	{ id: "equalizer", label: "Equalizer", icon: <Sliders size={16} /> },
	{ id: "storage", label: "Storage", icon: <HardDrive size={16} /> },
	{ id: "shortcuts", label: "Shortcuts", icon: <Keyboard size={16} /> },
	{ id: "advanced", label: "Advanced", icon: <Cpu size={16} /> },
	...(import.meta.env.DEV
		? [{ id: "profiler" as Tab, label: "Profiler", icon: <Activity size={16} /> }]
		: []),
	{ id: "about", label: "About", icon: <CircleHelp size={16} /> },
];

interface Props {
	isOpen: boolean;
	onClose: () => void;
}

interface SettingsSwitchProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	disabled?: boolean;
}

function SettingsSwitch({ checked, onChange, label, disabled = false }: SettingsSwitchProps) {
	return (
		<label className="settings-switch">
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(event) => onChange(event.target.checked)}
				aria-label={label}
			/>
			<span className="settings-switch-track">
				<span className="settings-switch-thumb" />
			</span>
		</label>
	);
}

export default function SettingsModal({ isOpen, onClose }: Props) {
	const [activeTab, setActiveTab] = useState<Tab>("general");
	const [artworkCacheSize, setArtworkCacheSize] = useState(0);
	const [clearedHistory, setClearedHistory] = useState(false);
	const [clearedArtwork, setClearedArtwork] = useState(false);
	const [isPeqExpanded, setIsPeqExpanded] = useState(false);
	const { addToast } = useToastStore();
	const { eqMode } = useSettingsStore();
	const settingsBodyRef = useRef<HTMLDivElement>(null);
	const isPeq = eqMode === "parametric";

	const refreshStats = useCallback(() => {
		setArtworkCacheSize(getArtworkCacheSize());
	}, []);

	useEffect(() => {
		if (isOpen) {
			refreshStats();
			setClearedHistory(false);
			setClearedArtwork(false);
			setActiveTab("general");
			setIsPeqExpanded(false);
		}
	}, [isOpen, refreshStats]);

	useEffect(() => {
		setIsPeqExpanded(false);
	}, [activeTab]);

	useEffect(() => {
		if (!isOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	const handleClearHistory = async () => {
		try {
			await clearPlayHistory();
			setClearedHistory(true);
			addToast("Play history cleared", "success");
		} catch {
			addToast("Failed to clear play history", "error");
		}
	};

	const handleClearArtwork = () => {
		clearArtworkCache();
		setArtworkCacheSize(0);
		setClearedArtwork(true);
		addToast("Artwork cache cleared", "success");
	};

	const handleClearAll = async () => {
		try {
			await clearPlayHistory();
			clearArtworkCache();
			setArtworkCacheSize(0);
			setClearedHistory(true);
			setClearedArtwork(true);
			addToast("All caches cleared", "success");
		} catch {
			addToast("Failed to clear all caches", "error");
		}
	};

	const isPeqPage = activeTab === "equalizer" && isPeq && isPeqExpanded;

	return createPortal(
		<div className="modal-overlay" onClick={onClose}>
			<div
				className={`settings-modal glass-panel-heavy${isPeqPage ? " settings-modal--peq-page" : ""}`}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Sidebar — hidden when PEQ full-page */}
				{!isPeqPage && (
					<aside className="settings-sidebar">
						<div className="settings-sidebar-title">Settings</div>
						<nav className="settings-nav">
							{NAV_ITEMS.map((item) => (
								<button
									key={item.id}
									className={`settings-nav-item${activeTab === item.id ? " active" : ""}`}
									onClick={() => setActiveTab(item.id)}
								>
									{item.icon}
									<span>{item.label}</span>
								</button>
							))}
						</nav>
					</aside>
				)}

				{/* Content */}
				<div className="settings-content">
					<div
						className={`settings-content-header${isPeqPage ? " settings-content-header--peq" : ""}`}
					>
						{isPeqPage ? (
							/* PEQ full-page header: back + title + close */
							<>
								<div className="settings-content-header-left">
									<button
										className="peq-back-btn"
										onClick={() => setIsPeqExpanded(false)}
										title="Back to Equalizer"
									>
										<ChevronLeft size={16} />
										<span>Equalizer</span>
									</button>
									<div className="peq-page-title">
										<FlaskConical size={14} />
										Parametric EQ
									</div>
									<PeqPresetControls />
								</div>
								<button
									className="icon-btn settings-close"
									onClick={onClose}
									title="Close"
								>
									<X size={18} />
								</button>
							</>
						) : (
							/* Normal header */
							<>
								<div className="settings-content-header-left">
									<h2>{NAV_ITEMS.find((i) => i.id === activeTab)?.label}</h2>
								</div>
								<button
									className="icon-btn settings-close"
									onClick={onClose}
									title="Close"
								>
									<X size={18} />
								</button>
							</>
						)}
					</div>

					<div className="settings-body-wrapper scrollbar-host">
						<div className="settings-body" ref={settingsBodyRef}>
							{activeTab === "general" && (
								<GeneralTab onOpenEqualizer={() => setActiveTab("equalizer")} />
							)}
							{activeTab === "appearance" && <AppearanceTab />}
							{activeTab === "equalizer" && (
								<EqualizerTab
									isExpanded={isPeqExpanded}
									onToggleExpand={() => setIsPeqExpanded(true)}
								/>
							)}
							{activeTab === "storage" && (
								<StorageTab
									artworkCacheSize={artworkCacheSize}
									clearedHistory={clearedHistory}
									clearedArtwork={clearedArtwork}
									onClearHistory={handleClearHistory}
									onClearArtwork={handleClearArtwork}
									onClearAll={handleClearAll}
								/>
							)}
							{activeTab === "shortcuts" && <ShortcutsTab />}
							{activeTab === "advanced" && <AdvancedTab />}
							{activeTab === "about" && <AboutTab />}
							{activeTab === "profiler" && <ProfilerTab />}
						</div>
						{!isPeqPage && <CustomScrollbar scrollRef={settingsBodyRef} />}
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}

// ── General tab ───────────────────────────────────────────────────────────────

interface GeneralTabProps {
	onOpenEqualizer: () => void;
}

function GeneralTab({ onOpenEqualizer }: GeneralTabProps) {
	const {
		closeToTray,
		setCloseToTray,
		exponentialVolume,
		setExponentialVolume,
		discordRpcEnabled,
		setDiscordRpcEnabled,
	} = useSettingsStore();

	return (
		<div className="settings-panel-list">
			<section className="settings-panel-group">
				<h3 className="settings-panel-title">Application</h3>
				<div className="settings-panel-controls">
					<div className="settings-select-row">
						<div>
							<div className="settings-select-label">When closing Viby</div>
							<div className="settings-control-desc">
								{closeToTray
									? "Viby continues playing from the system tray."
									: "Viby stops playback and exits completely."}
							</div>
						</div>
						<div className="settings-segmented" role="group" aria-label="When closing Viby">
							<button
								type="button"
								className={closeToTray ? "active" : ""}
								onClick={() => setCloseToTray(true)}
							>
								Background
							</button>
							<button
								type="button"
								className={!closeToTray ? "active" : ""}
								onClick={() => setCloseToTray(false)}
							>
								Close
							</button>
						</div>
					</div>
					<div className="settings-select-row">
						<label className="settings-select-label settings-select-label--icon">
							<MessageSquare size={14} />
							Discord Rich Presence
						</label>
						<SettingsSwitch
							checked={discordRpcEnabled}
							onChange={setDiscordRpcEnabled}
							label="Discord Rich Presence"
						/>
					</div>
				</div>
			</section>

			<section className="settings-panel-group">
				<h3 className="settings-panel-title">Playback</h3>
				<div className="settings-panel-controls">
					<div className="settings-select-row">
						<label className="settings-select-label">Volume slider curve</label>
						<div className="settings-segmented" role="group" aria-label="Volume slider curve">
							{[
								{ label: "Linear", exponential: false },
								{ label: "Natural", exponential: true },
							].map((option) => (
								<button
									key={option.label}
									type="button"
									className={exponentialVolume === option.exponential ? "active" : ""}
									onClick={() => {
										setExponentialVolume(option.exponential);
										const currentVol = usePlayerStore.getState().volume;
										setRustVolume(currentVol, { immediate: true }).catch((err) =>
											console.error("Failed to set volume on backend:", err),
										);
									}}
								>
									{option.label}
								</button>
							))}
						</div>
					</div>
					<button
						className="settings-navigation-row"
						type="button"
						onClick={onOpenEqualizer}
					>
						<span className="settings-select-label">Equalizer</span>
						<span className="settings-navigation-action">
							Open
							<ChevronRight size={14} />
						</span>
					</button>
				</div>
			</section>
		</div>
	);
}

function AdvancedTab() {
	const { gpuAcceleration, setGpuAcceleration } = useSettingsStore();
	const initialGpuAcceleration = useRef(gpuAcceleration);
	const [restartRequired, setRestartRequired] = useState(false);

	return (
		<div className="settings-panel-list">
			<section className="settings-panel-group">
				<h3 className="settings-panel-title">Rendering</h3>
				<div className="settings-panel-controls">
					<div className="settings-select-row">
						<div>
							<div className="settings-select-label">GPU acceleration</div>
							<div className="settings-control-desc">
								Disable only when troubleshooting rendering issues.
							</div>
						</div>
						<SettingsSwitch
							checked={gpuAcceleration}
							onChange={(enabled) => {
								setGpuAcceleration(enabled);
								setRestartRequired(enabled !== initialGpuAcceleration.current);
								useToastStore.getState().addToast(
									"GPU acceleration updated. Restart the app to apply changes.",
									"success",
								);
							}}
							label="GPU acceleration"
						/>
					</div>
				</div>
				{restartRequired && (
					<p className="settings-panel-note settings-panel-note--restart">
						Restart Viby to apply this change.
					</p>
				)}
			</section>
		</div>
	);
}

function AboutTab() {
	const [appInfo, setAppInfo] = useState({ name: "Viby", version: "" });

	useEffect(() => {
		Promise.all([getName(), getVersion()])
			.then(([name, version]) => setAppInfo({ name, version }))
			.catch((error) => console.error("Failed to load app information:", error));
	}, []);

	return (
		<div className="settings-panel-list">
			<section className="settings-panel-group">
				<h3 className="settings-panel-title">Application</h3>
				<div className="settings-about settings-about--detailed">
					<div className="settings-about-identity">
						<div className="settings-about-logo-wrap">
							<Logo
								className="settings-about-logo"
								accentColor="hsl(125, 75%, 70%)"
								aria-hidden="true"
							/>
						</div>
						<div className="settings-about-heading">
							<div className="settings-about-name">{appInfo.name}</div>
							<div className="settings-about-tagline">Viby is beyond your player.</div>
							{appInfo.version && (
								<div className="settings-about-version">Version {appInfo.version}</div>
							)}
						</div>
					</div>
					<div className="settings-about-desc">
						A lightweight, local-first music player with a responsive interface and a
						high-performance Rust audio engine.
					</div>
				</div>
			</section>

			<section className="settings-panel-group">
				<h3 className="settings-panel-title">Details</h3>
				<div className="settings-panel-content">
					<h4 className="settings-panel-content-title">Built For Your Library</h4>
					<p className="settings-about-copy">
						Viby provides gapless playback, quick library indexing, flexible equalizers,
						and a customizable interface across macOS, Windows, and Linux.
					</p>
					<h4 className="settings-panel-content-title">Technology</h4>
					<div className="settings-about-stack">Tauri 2 · React · TypeScript · Rust · SQLite</div>
					<div className="settings-info-row">
						<Info size={14} className="text-tertiary" />
						<span>
							Your library and settings stay on this device. Optional features such as
							Discord Rich Presence and font loading may communicate with external services.
						</span>
					</div>
					<h4 className="settings-panel-content-title settings-panel-content-title--subtle">License</h4>
					<div className="settings-license-box">
						<div className="settings-info-row settings-info-row--license">
							<Info size={14} className="text-tertiary" />
							<span>
								Viby is licensed under GPL-3.0-only. The full license text is included in
								the project root `LICENSE` file.
							</span>
						</div>
					</div>
				</div>
			</section>
		</div>
	);
}

// ── Appearance tab ────────────────────────────────────────────────────────────

function AppearanceTab() {
	const { showTitlebarEq, setShowTitlebarEq, showTitlebarName, setShowTitlebarName } = useSettingsStore();

	return (
		<div className="settings-panel-list">
			<section className="settings-panel-group">
				<h3 className="settings-panel-title">Window</h3>
				<div className="settings-panel-controls settings-group">
					<div className="settings-select-row">
						<label className="settings-select-label">Titlebar app name</label>
						<SettingsSwitch
							checked={showTitlebarName}
							onChange={setShowTitlebarName}
							label="Titlebar app name"
						/>
					</div>

					<div className={`settings-select-row settings-sub-row ${!showTitlebarName ? "disabled" : ""}`}>
						<label className="settings-select-label">Titlebar music visualizer</label>
						<SettingsSwitch
							checked={showTitlebarEq}
							onChange={setShowTitlebarEq}
							label="Titlebar music visualizer"
							disabled={!showTitlebarName}
						/>
					</div>
				</div>
			</section>

			<section className="settings-panel-group">
				<h3 className="settings-panel-title">Theme</h3>
				<ThemePicker />
			</section>
		</div>
	);
}

// ── Storage tab ───────────────────────────────────────────────────────────────

interface StorageTabProps {
	artworkCacheSize: number;
	clearedHistory: boolean;
	clearedArtwork: boolean;
	onClearHistory: () => void;
	onClearArtwork: () => void;
	onClearAll: () => void;
}

function StorageTab({
	artworkCacheSize,
	clearedHistory,
	clearedArtwork,
	onClearHistory,
	onClearArtwork,
	onClearAll,
}: StorageTabProps) {
	return (
		<div className="settings-panel-list">
			<section className="settings-panel-group">
				<h3 className="settings-panel-title">Stored Data</h3>
				<div className="storage-panel">
					<div className="cache-item">
						<div className="cache-item-icon">
							<Database size={18} />
						</div>
						<div className="cache-item-info">
							<div className="cache-item-name">Play history</div>
							<div className="cache-item-desc">
								Powers Recently Played and Top Artists.
							</div>
							<div className="cache-item-badge">Persistent · Up to 5,000 plays</div>
						</div>
						<div className="cache-item-action">
							{clearedHistory ? (
								<div className="cache-cleared-indicator">
									<CheckCircle2 size={16} /> Cleared
								</div>
							) : (
								<button className="btn-cache-clear" onClick={onClearHistory}>
									<Trash2 size={14} /> Clear
								</button>
							)}
						</div>
					</div>

					<div className="cache-item">
						<div className="cache-item-icon">
							<Image size={18} />
						</div>
						<div className="cache-item-info">
							<div className="cache-item-name">Artwork cache</div>
							<div className="cache-item-desc">
								Keeps decoded artwork ready for faster display.
							</div>
							<div className="cache-item-badge cache-item-badge--session">
								Session · {artworkCacheSize} / 500 images
							</div>
						</div>
						<div className="cache-item-action">
							{clearedArtwork ? (
								<div className="cache-cleared-indicator">
									<CheckCircle2 size={16} /> Cleared
								</div>
							) : (
								<button
									className="btn-cache-clear"
									onClick={onClearArtwork}
									disabled={artworkCacheSize === 0}
								>
									<Trash2 size={14} /> Clear
								</button>
							)}
						</div>
					</div>

					<div className="cache-clear-all-row">
						<button
							className="btn-cache-clear-all"
							onClick={onClearAll}
							disabled={clearedHistory && clearedArtwork}
						>
							<Trash2 size={15} />
							Clear all
						</button>
					</div>
				</div>
				<p className="settings-panel-note">
					Clearing stored data does not affect your library or playlists.
				</p>
			</section>
		</div>
	);
}

// ── Shortcuts tab ─────────────────────────────────────────────────────────────

function ShortcutsTab() {
	const isMac = navigator.userAgent.toLowerCase().includes("mac");
	const modKey = isMac ? "⌘" : "Ctrl";

	const shortcutGroups = [
		{
			category: "Application",
			shortcuts: [
				{ action: "Quit app", keys: [modKey, "Q"] },
				{ action: "Close active modal", keys: ["Esc"] },
			],
		},
		{
			category: "Playback",
			shortcuts: [
				{ action: "Play / Pause", keys: ["Space"] },
				{ action: "Next track", keys: [modKey, "→"] },
				{ action: "Previous track", keys: [modKey, "←"] },
				{ action: "Volume up", keys: [modKey, "↑"] },
				{ action: "Volume down", keys: [modKey, "↓"] },
			],
		},
		{
			category: "Navigation",
			shortcuts: [
				{ action: "Global search", keys: [modKey, "K"] },
				{ action: "Focus library search", keys: ["/"] },
			],
		},
	];

	return (
		<div className="shortcuts-groups">
			{shortcutGroups.map((group) => (
				<section className="settings-panel-group" key={group.category}>
					<h3 className="settings-panel-title">{group.category}</h3>
					<div className="shortcuts-group">
						{group.shortcuts.map((shortcut) => (
							<div className="shortcut-row" key={shortcut.action}>
								<span className="shortcut-action">{shortcut.action}</span>
								<span className="shortcut-keys">
									{shortcut.keys.map((key, index) => (
										<span className="shortcut-key-part" key={`${shortcut.action}-${key}`}>
											{index > 0 && <span className="shortcut-key-plus">+</span>}
											<kbd className="shortcuts-key-cap">{key}</kbd>
										</span>
									))}
								</span>
							</div>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

// ── Profiler tab ──────────────────────────────────────────────────────────────
function ProfilerTab() {
	const [logs, setLogs] = useState(getProfileLogs());
	const consoleRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setIgnoreRenders(true);
		const unsubscribe = subscribeToProfiler(() => {
			setLogs(getProfileLogs());
		});
		return () => {
			unsubscribe();
			setIgnoreRenders(false);
		};
	}, []);

	// Auto-scroll to bottom of console when new logs arrive
	useEffect(() => {
		if (consoleRef.current) {
			consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
		}
	}, [logs.length]);

	const handleCopy = () => {
		const text = logs
			.map((log) => `[${log.timeStr}][${log.type.toUpperCase()}] ${log.message}`)
			.join("\n");
		navigator.clipboard.writeText(text);
	};

	// Statistics
	const rendersCount = logs.filter((l) => l.type === "render").length;
	const errorsCount = logs.filter((l) => l.type === "error").length;
	const avgRenderTime =
		logs
			.filter((l) => l.type === "render" && l.details?.actualDuration)
			.reduce((acc, curr) => acc + curr.details.actualDuration, 0) /
		(logs.filter((l) => l.type === "render" && l.details?.actualDuration).length || 1);

	return (
		<div className="profiler-tab">
			<div className="profiler-stats">
				<div className="profiler-stat-card">
					<div className="profiler-stat-val">{logs.length}</div>
					<div className="profiler-stat-lbl">Total Events</div>
				</div>
				<div className="profiler-stat-card">
					<div className={`profiler-stat-val${errorsCount > 0 ? " profiler-stat-val--error" : ""}`}>
						{errorsCount}
					</div>
					<div className="profiler-stat-lbl">Errors Caught</div>
				</div>
				<div className="profiler-stat-card">
					<div className="profiler-stat-val">{rendersCount}</div>
					<div className="profiler-stat-lbl">Renders Logged</div>
				</div>
				<div className="profiler-stat-card">
					<div className="profiler-stat-val">
						{rendersCount > 0 ? `${avgRenderTime.toFixed(1)}ms` : "—"}
					</div>
					<div className="profiler-stat-lbl">Avg Render Time</div>
				</div>
			</div>

			<div className="profiler-actions">
				<button className="profiler-action-btn" onClick={handleCopy} disabled={logs.length === 0}>
					Copy Logs
				</button>
				<button
					className="profiler-action-btn profiler-action-btn--danger"
					onClick={clearProfileLogs}
					disabled={logs.length === 0}
				>
					Clear Logs
				</button>
			</div>

			<div className="profiler-console" ref={consoleRef}>
				{logs.length === 0 ? (
					<div className="profiler-empty">
						No logs captured yet. Try skipping songs or triggering player actions.
					</div>
				) : (
					logs.map((log, index) => (
						<div key={index} className="profiler-log-row">
							<span className="profiler-log-time">{log.timeStr}</span>
							<span className={`profiler-log-type ${log.type}`}>[{log.type.toUpperCase()}]</span>
							<span className="profiler-log-msg">{log.message}</span>
						</div>
					))
				)}
			</div>
		</div>
	);
}
