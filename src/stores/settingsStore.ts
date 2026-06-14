import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { setGpuAcceleration as setGpuAccelerationBackend } from "../utils/tauri";
import { getPlatform } from "../utils/platform";

export const EQ_BAND_COUNT = 10;
export const PEQ_BAND_COUNT = 8;
const DEFAULT_GPU_ACCELERATION = getPlatform() !== "linux";

export interface EqPreset {
	name: string;
	preamp: number;
	gains: number[];
}

export interface PeqPreset {
	name: string;
	preamp: number;
	bands: PeqBand[];
	selectedMeasurements?: string[];
	selectedTargets?: string[];
}

// filter_type: 0=Peaking, 1=LowShelf, 2=HighShelf, 3=LowPass, 4=HighPass
export interface PeqBand {
	enabled: boolean;
	filterType: 0 | 1 | 2 | 3 | 4;
	freq: number; // Hz, 20–20000
	gain: number; // dB, -12 to +12 (ignored for LP/HP)
	q: number; // 0.1–10
}

const DEFAULT_PEQ_BANDS: PeqBand[] = [
	{ enabled: true, filterType: 1, freq: 100, gain: 0, q: 0.707 },
	{ enabled: true, filterType: 0, freq: 200, gain: 0, q: 1.0 },
	{ enabled: true, filterType: 0, freq: 500, gain: 0, q: 1.0 },
	{ enabled: true, filterType: 0, freq: 1000, gain: 0, q: 1.0 },
	{ enabled: true, filterType: 0, freq: 2000, gain: 0, q: 1.0 },
	{ enabled: true, filterType: 0, freq: 4000, gain: 0, q: 1.0 },
	{ enabled: true, filterType: 0, freq: 8000, gain: 0, q: 1.0 },
	{ enabled: true, filterType: 2, freq: 12000, gain: 0, q: 0.707 },
];

interface SettingsState {
	closeToTray: boolean;
	setCloseToTray: (value: boolean) => void;
	miniPlayerAlwaysOnTop: boolean;
	setMiniPlayerAlwaysOnTop: (value: boolean) => void;
	gpuAcceleration: boolean;
	setGpuAccelerationLocal: (value: boolean) => void;
	setGpuAcceleration: (value: boolean) => void;
	exponentialVolume: boolean;
	setExponentialVolume: (value: boolean) => void;
	discordRpcEnabled: boolean;
	setDiscordRpcEnabled: (value: boolean) => void;
	showTitlebarEq: boolean;
	setShowTitlebarEq: (value: boolean) => void;

	// Equalizer (shared)
	eqEnabled: boolean;
	setEqEnabled: (value: boolean) => void;
	eqMode: "graphic" | "parametric";
	setEqMode: (mode: "graphic" | "parametric") => void;

	// Graphic EQ
	eqPreamp: number;
	setEqPreamp: (value: number) => void;
	eqGains: number[];
	setEqGains: (value: number[]) => void;
	eqPresets: EqPreset[];
	addEqPreset: (preset: EqPreset) => void;
	removeEqPreset: (name: string) => void;

	// Parametric EQ
	peqBands: PeqBand[];
	setPeqBand: (index: number, patch: Partial<PeqBand>) => void;
	setPeqBands: (bands: PeqBand[]) => void;
	addPeqBand: () => void;
	removePeqBand: (index: number) => void;
	sortPeqBands: () => void;

	// PEQ Presets
	peqPresets: PeqPreset[];
	selectedPeqPresetName: string;
	setSelectedPeqPresetName: (name: string) => void;
	addPeqPreset: (preset: PeqPreset) => void;
	removePeqPreset: (name: string) => void;

	// Headphone measurements selection
	selectedMeasurements: string[];
	setSelectedMeasurements: (
		value: string[] | ((prev: string[]) => string[]),
	) => void;

	// Target curves selection
	selectedTargets: string[];
	setSelectedTargets: (
		value: string[] | ((prev: string[]) => string[]),
	) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			closeToTray: true,
			setCloseToTray: (value) => {
				set({ closeToTray: value });
				invoke("set_close_to_tray", { enabled: value }).catch((err) =>
					console.error("Failed to set close to tray on backend:", err),
				);
			},
			miniPlayerAlwaysOnTop: true,
			setMiniPlayerAlwaysOnTop: (value) =>
				set({ miniPlayerAlwaysOnTop: value }),
			gpuAcceleration: DEFAULT_GPU_ACCELERATION,
			setGpuAccelerationLocal: (value) => set({ gpuAcceleration: value }),
			setGpuAcceleration: (value) => {
				set({ gpuAcceleration: value });
				setGpuAccelerationBackend(value).catch((err) =>
					console.error("Failed to set GPU acceleration on backend:", err),
				);
			},
			exponentialVolume: false,
			setExponentialVolume: (value) => set({ exponentialVolume: value }),
			discordRpcEnabled: false,
			setDiscordRpcEnabled: (value) => {
				set({ discordRpcEnabled: value });
				invoke("set_discord_rpc_enabled", { enabled: value }).catch((err) =>
					console.error("Failed to set Discord RPC enabled on backend:", err),
				);
			},
			showTitlebarEq: true,
			setShowTitlebarEq: (value) => set({ showTitlebarEq: value }),

			eqEnabled: false,
			setEqEnabled: (value) => set({ eqEnabled: value }),
			eqMode: "graphic",
			setEqMode: (mode) => set({ eqMode: mode }),

			eqPreamp: 0,
			setEqPreamp: (value) => set({ eqPreamp: value }),
			eqGains: Array(EQ_BAND_COUNT).fill(0),
			setEqGains: (value) => set({ eqGains: value }),
			eqPresets: [],
			addEqPreset: (preset) =>
				set((s) => ({
					eqPresets: [
						...s.eqPresets.filter((p) => p.name !== preset.name),
						preset,
					],
				})),
			removeEqPreset: (name) =>
				set((s) => ({
					eqPresets: s.eqPresets.filter((p) => p.name !== name),
				})),

			peqBands: DEFAULT_PEQ_BANDS,
			setPeqBand: (index, patch) =>
				set((s) => {
					const next = s.peqBands.slice();
					next[index] = { ...next[index], ...patch };
					return { peqBands: next };
				}),
			setPeqBands: (bands) =>
				set({ peqBands: [...bands].sort((a, b) => a.freq - b.freq) }),
			addPeqBand: () =>
				set((s) => ({
					peqBands: [
						...s.peqBands,
						{
							enabled: true,
							filterType: 0 as const,
							freq: 1000,
							gain: 0,
							q: 1.0,
						},
					].sort((a, b) => a.freq - b.freq),
				})),
			removePeqBand: (index) =>
				set((s) => ({
					peqBands: s.peqBands.filter((_, i) => i !== index),
				})),
			sortPeqBands: () =>
				set((s) => ({
					peqBands: [...s.peqBands].sort((a, b) => a.freq - b.freq),
				})),

			peqPresets: [],
			selectedPeqPresetName: "",
			setSelectedPeqPresetName: (name) => set({ selectedPeqPresetName: name }),
			addPeqPreset: (preset) =>
				set((s) => ({
					peqPresets: [
						...s.peqPresets.filter((p) => p.name !== preset.name),
						preset,
					],
					selectedPeqPresetName: preset.name,
				})),
			removePeqPreset: (name) =>
				set((s) => ({
					peqPresets: s.peqPresets.filter((p) => p.name !== name),
					selectedPeqPresetName:
						s.selectedPeqPresetName === name ? "" : s.selectedPeqPresetName,
				})),

			selectedMeasurements: [],
			setSelectedMeasurements: (value) =>
				set((s) => ({
					selectedMeasurements:
						typeof value === "function" ? value(s.selectedMeasurements) : value,
				})),

			selectedTargets: [],
			setSelectedTargets: (value) =>
				set((s) => ({
					selectedTargets:
						typeof value === "function" ? value(s.selectedTargets) : value,
				})),
		}),
		{ name: "viby-settings" },
	),
);
