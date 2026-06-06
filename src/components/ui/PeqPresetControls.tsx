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
        if (match) return preset.name;
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
      <div className="eq-peq-preset-save-wrap" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <input
          className="eq-save-input"
          type="text"
          autoFocus
          placeholder="Preset name…"
          value={peqPresetDraftName}
          maxLength={24}
          style={{ height: '22px', fontSize: '0.72rem', padding: '0 6px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
          onChange={e => setPeqPresetDraftName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') confirmSavePeqPreset();
            if (e.key === 'Escape') setSavingPeqPreset(false);
          }}
        />
        <button className="eq-save-btn eq-save-btn--ok" onClick={confirmSavePeqPreset}
          disabled={!peqPresetDraftName.trim()} title="Save"
          style={{ width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '4px', cursor: 'pointer' }}><Check size={12} /></button>
        <button className="eq-save-btn" onClick={() => setSavingPeqPreset(false)} title="Cancel"
          style={{ width: '22px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', border: 'none', borderRadius: '4px', cursor: 'pointer' }}><X size={12} /></button>
      </div>
    );
  }

  return (
    <div className="eq-peq-preset-dropdown-wrap" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <Dropdown
        className="peq-preset-dropdown"
        value={getActivePeqPresetName()}
        options={peqPresets.map(p => ({ value: p.name, label: p.name }))}
        placeholder="Select Preset..."
        disabled={!eqEnabled}
        onChange={handleLoadPreset}
      />

      <button
        className="eq-pill eq-pill--save-peq"
        disabled={!eqEnabled}
        onClick={() => setSavingPeqPreset(true)}
        title="Save current filters as preset"
        style={{ width: '28px', height: '28px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '4px', color: 'var(--text-secondary)', cursor: 'pointer' }}
      >
        <Plus size={14} />
      </button>

      {getActivePeqPresetName() && (
        <button
          className="eq-pill eq-pill--delete-peq"
          disabled={!eqEnabled}
          onClick={() => handleDeletePreset(getActivePeqPresetName())}
          title="Delete selected preset"
          style={{ width: '28px', height: '28px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '4px', color: 'rgba(255,90,90,0.8)', cursor: 'pointer' }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
