import { useMemo, useState } from "react";
import { Check, Plus, Save, X } from "lucide-react";
import { useSettingsStore, type PeqPreset } from "../../stores/settingsStore";
import { setPeq } from "../../utils/tauri";
import { useToastStore } from "../../stores/toastStore";
import Dropdown from "./Dropdown";

export default function PeqPresetControls() {
	const {
		eqEnabled,
		eqPreamp,
		peqBands,
		peqPresets,
		selectedPeqPresetName,
		setSelectedPeqPresetName,
		setEqPreamp,
		setPeqBands,
		addPeqPreset,
		removePeqPreset,
		selectedMeasurements,
		setSelectedMeasurements,
		selectedTargets,
		setSelectedTargets,
	} = useSettingsStore();
	const [savingPeqPreset, setSavingPeqPreset] = useState(false);
	const [peqPresetDraftName, setPeqPresetDraftName] = useState("");

	const selectedPresetExists = useMemo(
		() => peqPresets.some((p) => p.name === selectedPeqPresetName),
		[peqPresets, selectedPeqPresetName],
	);

	const selectedPresetValue = selectedPresetExists ? selectedPeqPresetName : "";

	const buildCurrentPreset = (name: string): PeqPreset => ({
		name,
		preamp: eqPreamp,
		bands: peqBands,
		selectedMeasurements,
		selectedTargets,
	});

	const handleLoadPreset = async (name: string) => {
		setSelectedPeqPresetName(name);
		if (!name) return;
		const preset = peqPresets.find((p) => p.name === name);
		if (!preset) return;

		setEqPreamp(preset.preamp);
		setPeqBands(preset.bands);
		if (preset.selectedMeasurements) {
			setSelectedMeasurements(preset.selectedMeasurements);
		}
		if (preset.selectedTargets) {
			setSelectedTargets(preset.selectedTargets);
		}

		try {
			await setPeq(
				eqEnabled,
				preset.preamp,
				preset.bands.map((b) => ({
					enabled: b.enabled,
					filter_type: b.filterType,
					freq: b.freq,
					gain: b.gain,
					q: b.q,
				})),
			);
			useToastStore
				.getState()
				.addToast(`Loaded PEQ preset: ${name}`, "success");
		} catch (err) {
			console.error(err);
			useToastStore.getState().addToast("Failed to load PEQ preset.", "error");
		}
	};

	const confirmSaveAsPeqPreset = () => {
		const trimmedName = peqPresetDraftName.trim();
		if (!trimmedName) return;
		addPeqPreset(buildCurrentPreset(trimmedName));
		setSavingPeqPreset(false);
		setPeqPresetDraftName("");
		useToastStore
			.getState()
			.addToast(`Saved PEQ preset: ${trimmedName}`, "success");
	};

	const handleSaveSelectedPreset = () => {
		if (!selectedPresetValue) return;
		addPeqPreset(buildCurrentPreset(selectedPresetValue));
		useToastStore
			.getState()
			.addToast(`Updated PEQ preset: ${selectedPresetValue}`, "success");
	};

	const handleDeletePreset = (name: string) => {
		removePeqPreset(name);
		useToastStore.getState().addToast(`Deleted PEQ preset: ${name}`, "success");
	};

	if (savingPeqPreset) {
		return (
			<div className="eq-peq-preset-save-wrap">
				<input
					className="eq-peq-preset-save-input"
					type="text"
					autoFocus
					placeholder="Preset name…"
					value={peqPresetDraftName}
					maxLength={24}
					onChange={(e) => setPeqPresetDraftName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") confirmSaveAsPeqPreset();
						if (e.key === "Escape") setSavingPeqPreset(false);
					}}
				/>
				<button
					className="eq-peq-preset-btn eq-peq-preset-btn--save"
					onClick={confirmSaveAsPeqPreset}
					disabled={!peqPresetDraftName.trim()}
					title="Save as preset"
				>
					<Check size={12} />
				</button>
				<button
					className="eq-peq-preset-btn"
					onClick={() => setSavingPeqPreset(false)}
					title="Cancel"
				>
					<X size={12} />
				</button>
			</div>
		);
	}

	return (
		<div className="eq-peq-preset-dropdown-wrap">
			<Dropdown
				className="peq-preset-dropdown"
				value={selectedPresetValue}
				options={peqPresets.map((p) => ({ value: p.name, label: p.name }))}
				placeholder="Select Preset..."
				disabled={!eqEnabled}
				onChange={handleLoadPreset}
			/>

			<button
				className="eq-peq-preset-btn eq-peq-preset-btn--save"
				disabled={!eqEnabled || !selectedPresetValue}
				onClick={handleSaveSelectedPreset}
				title="Save changes to selected preset"
			>
				<Save size={13} />
			</button>

			<button
				className="eq-peq-preset-btn eq-peq-preset-btn--add"
				disabled={!eqEnabled}
				onClick={() => {
					setPeqPresetDraftName(
						selectedPresetValue ? `${selectedPresetValue} Copy` : "",
					);
					setSavingPeqPreset(true);
				}}
				title="Save current filters as a new preset"
			>
				<Plus size={14} />
			</button>

			{selectedPresetValue && (
				<button
					className="eq-peq-preset-btn eq-peq-preset-btn--delete"
					disabled={!eqEnabled}
					onClick={() => handleDeletePreset(selectedPresetValue)}
					title="Delete selected preset"
				>
					<X size={12} />
				</button>
			)}
		</div>
	);
}
