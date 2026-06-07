import { useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { setPeq } from '../../utils/tauri';
import { useToastStore } from '../../stores/toastStore';
import Dropdown from './Dropdown';

export default function PeqPresetControls() {
  const {
    eqEnabled,
    eqPreamp,
    peqBands,
    peqPresets,
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
  const [peqPresetDraftName, setPeqPresetDraftName] = useState('');

  const getActivePeqPresetName = () => {
    for (const preset of peqPresets) {
      if (preset.preamp === eqPreamp && preset.bands.length === peqBands.length) {
        const match = preset.bands.every((b, idx) => {
          const current = peqBands[idx];
          return current &&
            current.enabled === b.enabled &&
            current.filterType === b.filterType &&
            current.freq === b.freq &&
            current.gain === b.gain &&
            current.q === b.q;
        });

        let selectionMatch = true;
        if (preset.selectedMeasurements !== undefined) {
          selectionMatch = selectionMatch &&
            preset.selectedMeasurements.length === selectedMeasurements.length &&
            preset.selectedMeasurements.every(m => selectedMeasurements.includes(m));
        }
        if (preset.selectedTargets !== undefined) {
          selectionMatch = selectionMatch &&
            preset.selectedTargets.length === selectedTargets.length &&
            preset.selectedTargets.every(t => selectedTargets.includes(t));
        }

        if (match && selectionMatch) return preset.name;
      }
    }
    return '';
  };

  const handleLoadPreset = async (name: string) => {
    if (!name) return;
    const preset = peqPresets.find(p => p.name === name);
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
      await setPeq(eqEnabled, preset.preamp, preset.bands.map(b => ({
        enabled: b.enabled,
        filter_type: b.filterType,
        freq: b.freq,
        gain: b.gain,
        q: b.q,
      })));
      useToastStore.getState().addToast(`Loaded PEQ preset: ${name}`, 'success');
    } catch (err) {
      console.error(err);
      useToastStore.getState().addToast('Failed to load PEQ preset.', 'error');
    }
  };

  const confirmSavePeqPreset = () => {
    const trimmedName = peqPresetDraftName.trim();
    if (!trimmedName) return;
    addPeqPreset({
      name: trimmedName,
      preamp: eqPreamp,
      bands: peqBands,
      selectedMeasurements,
      selectedTargets,
    });
    setSavingPeqPreset(false);
    setPeqPresetDraftName('');
    useToastStore.getState().addToast(`Saved PEQ preset: ${trimmedName}`, 'success');
  };

  const handleDeletePreset = (name: string) => {
    removePeqPreset(name);
    useToastStore.getState().addToast(`Deleted PEQ preset: ${name}`, 'success');
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
          onChange={e => setPeqPresetDraftName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') confirmSavePeqPreset();
            if (e.key === 'Escape') setSavingPeqPreset(false);
          }}
        />
        <button className="eq-peq-preset-btn eq-peq-preset-btn--save" onClick={confirmSavePeqPreset}
          disabled={!peqPresetDraftName.trim()} title="Save"><Check size={12} /></button>
        <button className="eq-peq-preset-btn" onClick={() => setSavingPeqPreset(false)} title="Cancel"><X size={12} /></button>
      </div>
    );
  }

  return (
    <div className="eq-peq-preset-dropdown-wrap">
      <Dropdown
        className="peq-preset-dropdown"
        value={getActivePeqPresetName()}
        options={peqPresets.map(p => ({ value: p.name, label: p.name }))}
        placeholder="Select Preset..."
        disabled={!eqEnabled}
        onChange={handleLoadPreset}
      />

      <button
        className="eq-peq-preset-btn eq-peq-preset-btn--add"
        disabled={!eqEnabled}
        onClick={() => setSavingPeqPreset(true)}
        title="Save current filters as preset"
      >
        <Plus size={14} />
      </button>

      {getActivePeqPresetName() && (
        <button
          className="eq-peq-preset-btn eq-peq-preset-btn--delete"
          disabled={!eqEnabled}
          onClick={() => handleDeletePreset(getActivePeqPresetName())}
          title="Delete selected preset"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
