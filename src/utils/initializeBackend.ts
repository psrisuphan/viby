import { invoke } from "@tauri-apps/api/core";

import { usePlayerStore } from "../stores/playerStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
	analyzeMissingNormalization,
	getGpuAcceleration,
	setBackgroundAppEnabled,
	setEq,
	setPeq,
	setRepeat,
	setShuffle,
	setSoundCheckEnabled,
	setSoundCheckTargetLufs,
	setVolume,
} from "./tauri";

async function reportFailure(label: string, operation: Promise<unknown>) {
	await operation.catch((error) => console.error(label, error));
}

export async function restoreBackendState() {
	const player = usePlayerStore.getState();
	await Promise.all([
		reportFailure(
			"Failed to sync persisted volume:",
			setVolume(player.volume, { immediate: true }),
		),
		reportFailure("Failed to sync persisted shuffle mode:", setShuffle(player.shuffle)),
		reportFailure("Failed to sync persisted repeat mode:", setRepeat(player.repeatMode)),
	]);

	const settings = useSettingsStore.getState();
	await Promise.all([
		reportFailure(
			"Failed to sync background app mode on startup:",
			setBackgroundAppEnabled(settings.closeToTray),
		),
		reportFailure(
			"Failed to sync background renderer suspension:",
			invoke("set_renderer_suspension_enabled", {
				enabled: settings.rendererSuspensionEnabled,
			}),
		),
		reportFailure(
			"Failed to sync Discord RPC setting on startup:",
			invoke("set_discord_rpc_enabled", { enabled: settings.discordRpcEnabled }),
		),
		reportFailure(
			"Failed to sync Discord RPC quality setting on startup:",
			invoke("set_discord_rpc_quality_enabled", {
				enabled: settings.discordRpcQualityEnabled,
			}),
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
