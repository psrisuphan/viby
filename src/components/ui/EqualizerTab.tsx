import { useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import { useSettingsStore, EQ_BAND_COUNT, DEFAULT_Q } from '../../stores/settingsStore';
import { setEq } from '../../utils/tauri';
import './EqualizerTab.css';

// Band labels mirror the backend FREQS array in eq.rs.
const BAND_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

const GAIN_MIN = -12;
const GAIN_MAX = 12;

// Preset gain curves (dB per band).
const PRESETS: { name: string; gains: number[] }[] = [
  { name: 'Flat',         gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Bass Boost',   gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] },
  { name: 'Treble Boost', gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] },
  { name: 'Vocal',        gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: 'V-Shape',      gains: [6, 4, 2, 0, -2, -2, 0, 2, 4, 6] },
];

export default function EqualizerTab() {
  const {
    eqEnabled, setEqEnabled,
    eqPreamp, setEqPreamp,
    eqGains, setEqGains,
    eqCustomQ, setEqCustomQ,
    eqQ, setEqQ,
  } = useSettingsStore();

  // Push current settings to the backend. Accepts overrides so callers can
  // sync the value they just set without waiting for a store re-render.
  const push = useCallback((o?: Partial<{
    enabled: boolean; preamp: number; gains: number[]; customQ: boolean; q: number;
  }>) => {
    const enabled = o?.enabled ?? eqEnabled;
    const preamp = o?.preamp ?? eqPreamp;
    const gains = o?.gains ?? eqGains;
    const customQ = o?.customQ ?? eqCustomQ;
    const q = customQ ? (o?.q ?? eqQ) : DEFAULT_Q;
    setEq(enabled, preamp, q, gains);
  }, [eqEnabled, eqPreamp, eqGains, eqCustomQ, eqQ]);

  const handleEnabled = (v: boolean) => { setEqEnabled(v); push({ enabled: v }); };

  const handlePreamp = (v: number) => { setEqPreamp(v); push({ preamp: v }); };

  const handleBand = (index: number, value: number) => {
    const next = eqGains.slice();
    next[index] = value;
    setEqGains(next);
    push({ gains: next });
  };

  const applyPreset = (gains: number[]) => {
    const next = gains.slice(0, EQ_BAND_COUNT);
    setEqGains(next);
    push({ gains: next });
  };

  const handleCustomQ = (v: boolean) => { setEqCustomQ(v); push({ customQ: v }); };

  const handleQ = (v: number) => { setEqQ(v); push({ q: v, customQ: true }); };

  const disabled = !eqEnabled;

  return (
    <div className="settings-section-list">
      {/* Master toggle */}
      <div className="eq-toggle-row">
        <div>
          <div className="eq-toggle-label">Equalizer</div>
          <div className="eq-toggle-sub">Shape the sound with a 10-band graphic EQ.</div>
        </div>
        <label className="eq-switch">
          <input type="checkbox" checked={eqEnabled} onChange={e => handleEnabled(e.target.checked)} />
          <span className="eq-switch-track"><span className="eq-switch-thumb" /></span>
        </label>
      </div>

      {/* Sliders: preamp + 10 bands */}
      <div className={`eq-sliders${disabled ? ' eq-sliders--disabled' : ''}`}>
        <div className="eq-band eq-band--preamp">
          <div className="eq-band-value">{eqPreamp > 0 ? '+' : ''}{eqPreamp.toFixed(1)}</div>
          <input
            className="eq-slider"
            type="range"
            min={GAIN_MIN} max={GAIN_MAX} step={0.5}
            value={eqPreamp}
            disabled={disabled}
            onChange={e => handlePreamp(parseFloat(e.target.value))}
          />
          <div className="eq-band-label eq-band-label--preamp">Pre</div>
        </div>

        <div className="eq-divider" />

        {BAND_LABELS.map((label, i) => (
          <div className="eq-band" key={label}>
            <div className="eq-band-value">{eqGains[i] > 0 ? '+' : ''}{(eqGains[i] ?? 0).toFixed(1)}</div>
            <input
              className="eq-slider"
              type="range"
              min={GAIN_MIN} max={GAIN_MAX} step={0.5}
              value={eqGains[i] ?? 0}
              disabled={disabled}
              onChange={e => handleBand(i, parseFloat(e.target.value))}
            />
            <div className="eq-band-label">{label}</div>
          </div>
        ))}
      </div>

      {/* Presets */}
      <div className="eq-presets">
        {PRESETS.map(p => (
          <button
            key={p.name}
            className="eq-preset-btn"
            disabled={disabled}
            onClick={() => applyPreset(p.gains)}
          >
            {p.name === 'Flat' && <RotateCcw size={12} />}
            {p.name}
          </button>
        ))}
      </div>

      {/* Custom Q */}
      <div className="eq-q-row">
        <label className="eq-q-checkbox">
          <input
            type="checkbox"
            checked={eqCustomQ}
            disabled={disabled}
            onChange={e => handleCustomQ(e.target.checked)}
          />
          <span>Customize Q (band width)</span>
        </label>

        {eqCustomQ && (
          <div className="eq-q-control">
            <input
              className="eq-q-slider"
              type="range"
              min={0.3} max={3.0} step={0.1}
              value={eqQ}
              disabled={disabled}
              onChange={e => handleQ(parseFloat(e.target.value))}
            />
            <span className="eq-q-value">Q {eqQ.toFixed(1)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
