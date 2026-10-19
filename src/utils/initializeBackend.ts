import { useSettingsStore } from "../stores/settingsStore";
import { readLegacyPlaybackPreferences } from "./playerPreferences";
import {
	analyzeMissingNormalization,
	getGpuAcceleration,
  initializePlaybackPreferences,
	setBackgroundAppEnabled,
	setDiscordRpcEnabled,
	setDiscordRpcQualityEnabled,
	setEq,
	setPeq,
	setRendererSuspensionEnabled,
	setSoundCheckEnabled,
	setSoundCheckTargetLufs,
} from "./tauri";

async function reportFailure(label: string, operation: Promise<unknown>) {
	await operation.catch((error) => console.error(label, error));
}

export async function restoreBackendState() {
	const settings = useSettingsStore.getState();
	await Promise.all([
		reportFailure(
			"Failed to restore playback preferences:",
			initializePlaybackPreferences(
				readLegacyPlaybackPreferences(settings.exponentialVolume),
			),
		),
		reportFailure(
			"Failed to sync background app mode on startup:",
			setBackgroundAppEnabled(settings.closeToTray),
		),
		reportFailure(
			"Failed to sync background renderer suspension:",
			setRendererSuspensionEnabled(settings.rendererSuspensionEnabled),
		),
		reportFailure(
			"Failed to sync Discord RPC setting on startup:",
			setDiscordRpcEnabled(settings.discordRpcEnabled),
		),
		reportFailure(
			"Failed to sync Discord RPC quality setting on startup:",
			setDiscordRpcQualityEnabled(settings.discordRpcQualityEnabled),
		),
		reportFailure(
			"Failed to sync Sound Check setting on startup:",
			setSoundCheckEnabled(settings.soundCheckEnabled),
		),
		reportFailure(
			"Failed to sync Sound Check target on startup:",
			setSoundCheckTargetLufs(settings.soundCheckTargetLufs),
		),
		reportFailure(
			"Failed to sync GPU acceleration setting:",
			getGpuAcceleration().then((enabled) =>
				useSettingsStore.getState().setGpuAccelerationLocal(enabled),
			),
		),
	]);

	if (settings.soundCheckEnabled) {
		void reportFailure(
			"Failed to start Sound Check analysis on startup:",
			analyzeMissingNormalization(),
		);
	}

	if (settings.eqMode === "parametric") {
		await reportFailure(
			"Failed to restore parametric EQ:",
			setPeq(
				settings.eqEnabled,
				settings.eqPreamp,
				settings.peqBands.map((band) => ({
					enabled: band.enabled,
					filter_type: band.filterType,
					freq: band.freq,
					gain: band.gain,
					q: band.q,
				})),
			),
		);
	} else {
		await reportFailure(
			"Failed to restore graphic EQ:",
			setEq(settings.eqEnabled, settings.eqPreamp, settings.eqGains),
		);
	}
}
