import { useCallback, useRef, useState } from 'react';
import { RotateCcw, SlidersHorizontal, Plus, Check, X, Bookmark } from 'lucide-react';
import { useSettingsStore, EQ_BAND_COUNT, DEFAULT_Q, type EqPreset } from '../../stores/settingsStore';
import { setEq } from '../../utils/tauri';
import './EqualizerTab.css';

// Band labels mirror the backend FREQS array in eq.rs.
const BAND_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

const GAIN_MIN = -12;
const GAIN_MAX = 12;
const Q_MIN = 0.1;
const Q_MAX = 5.0;

// Round to 2 decimals — the precision the user can type / the slider stores.
const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/// Vertical slider with a bipolar fill that grows from the 0 dB center line.
/// Driven by pointer events (not a native range input) so the drag direction
/// is correct on every engine, including webkitgtk on Linux.
function VSlider({ value, min, max, disabled, accent, onChange }: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  accent?: boolean;
  onChange: (v: number) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const range = max - min;
  const pct = ((value - min) / range) * 100;       // thumb position from bottom
  const centerPct = ((0 - min) / range) * 100;      // 0 dB reference
  const fillBottom = Math.min(pct, centerPct);
  const fillHeight = Math.abs(pct - centerPct);

  const valueFromY = (clientY: number) => {
    const el = areaRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    // Top of the area = max, bottom = min.
    const t = clamp((rect.bottom - clientY) / rect.height, 0, 1);
    return min + t * range;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    onChange(valueFromY(e.clientY));
    const move = (ev: PointerEvent) => onChange(valueFromY(ev.clientY));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`eq-vslider${accent ? ' eq-vslider--accent' : ''}${disabled ? ' is-disabled' : ''}`}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => !disabled && onChange(0)}
      title="Drag to adjust · double-click to reset"
    >
      <div className="eq-vslider-area" ref={areaRef}>
        <div className="eq-vslider-track" />
        <div className="eq-vslider-center" style={{ bottom: `${centerPct}%` }} />
        <div className="eq-vslider-fill" style={{ bottom: `${fillBottom}%`, height: `${fillHeight}%` }} />
        <div className="eq-vslider-thumb" style={{ bottom: `${pct}%` }} />
      </div>
    </div>
  );
}

/// Editable numeric field that shows 2 decimals, lets the user type a value,
/// and commits (clamped + rounded) on blur or Enter.
function NumField({ value, min, max, disabled, onCommit, className }: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? value.toFixed(2);

  const commit = () => {
    if (draft !== null) {
      const parsed = parseFloat(draft);
      if (!isNaN(parsed)) onCommit(round2(clamp(parsed, min, max)));
      setDraft(null);
    }
  };

  return (
    <input
      className={`eq-num${className ? ` ${className}` : ''}`}
      type="text"
      inputMode="decimal"
      value={display}
      disabled={disabled}
      onFocus={e => e.currentTarget.select()}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

export default function EqualizerTab() {
  const {
    eqEnabled, setEqEnabled,
    eqPreamp, setEqPreamp,
    eqGains, setEqGains,
    eqCustomQ, setEqCustomQ,
    eqQs, setEqQs,
    eqPresets, addEqPreset, removeEqPreset,
  } = useSettingsStore();

  const [saving, setSaving] = useState(false);
  const [draftName, setDraftName] = useState('');

  // Push current settings to the backend. Accepts overrides so callers can
  // sync the value they just set without waiting for a store re-render.
  const push = useCallback((o?: Partial<{
    enabled: boolean; preamp: number; gains: number[]; customQ: boolean; qs: number[];
  }>) => {
    const enabled = o?.enabled ?? eqEnabled;
    const preamp = o?.preamp ?? eqPreamp;
    const gains = o?.gains ?? eqGains;
    const customQ = o?.customQ ?? eqCustomQ;
    const qs = customQ ? (o?.qs ?? eqQs) : eqGains.map(() => DEFAULT_Q);
    setEq(enabled, preamp, qs, gains);
  }, [eqEnabled, eqPreamp, eqGains, eqCustomQ, eqQs]);

  const handleEnabled = (v: boolean) => { setEqEnabled(v); push({ enabled: v }); };

  const handlePreamp = (v: number) => { const r = round2(v); setEqPreamp(r); push({ preamp: r }); };

  const handleBand = (index: number, value: number) => {
    const next = eqGains.slice();
    next[index] = round2(value);
    setEqGains(next);
    push({ gains: next });
  };

  const handleBandQ = (index: number, value: number) => {
    const next = eqQs.slice();
    next[index] = round2(value);
    setEqQs(next);
    push({ qs: next, customQ: true });
  };

  // Reset to flat: zero all band gains and the pre-amp.
  const resetFlat = () => {
    const gains = Array(EQ_BAND_COUNT).fill(0);
    setEqGains(gains);
    setEqPreamp(0);
    push({ gains, preamp: 0 });
  };

  const isFlat = eqPreamp === 0 && eqGains.every(g => g === 0);

  const applyUserPreset = (p: EqPreset) => {
    setEqPreamp(p.preamp);
    setEqGains(p.gains.slice());
    setEqQs(p.qs.slice());
    setEqCustomQ(p.customQ);
    push({ preamp: p.preamp, gains: p.gains, qs: p.qs, customQ: p.customQ });
  };

  const isActiveUserPreset = (p: EqPreset) =>
    Math.abs(p.preamp - eqPreamp) < 0.05 &&
    p.gains.every((g, i) => Math.abs((eqGains[i] ?? 0) - g) < 0.05) &&
    (!p.customQ || p.qs.every((q, i) => Math.abs((eqQs[i] ?? DEFAULT_Q) - q) < 0.05));

  const startSave = () => { setDraftName(''); setSaving(true); };
  const cancelSave = () => { setSaving(false); setDraftName(''); };
  const confirmSave = () => {
    const name = draftName.trim();
    if (!name) return;
    addEqPreset({
      name,
      preamp: eqPreamp,
      gains: eqGains.slice(),
      qs: eqQs.slice(),
      customQ: eqCustomQ,
    });
    setSaving(false);
    setDraftName('');
  };

  const handleCustomQ = (v: boolean) => { setEqCustomQ(v); push({ customQ: v }); };

  const resetQ = () => {
    const next = Array(EQ_BAND_COUNT).fill(DEFAULT_Q);
    setEqQs(next);
    push({ qs: next, customQ: true });
  };

  const disabled = !eqEnabled;

  return (
    <div className="settings-section-list">
      {/* Master toggle */}
      <div className="eq-header">
        <div className="eq-header-icon"><SlidersHorizontal size={18} /></div>
        <div className="eq-header-text">
          <div className="eq-header-title">Equalizer</div>
          <div className="eq-header-sub">Shape the sound with a 10-band graphic EQ.</div>
        </div>
        <label className="eq-switch">
          <input type="checkbox" checked={eqEnabled} onChange={e => handleEnabled(e.target.checked)} />
          <span className="eq-switch-track"><span className="eq-switch-thumb" /></span>
        </label>
      </div>

      {/* Custom Q */}
      <div className="eq-q-row">
        <label className="eq-q-toggle">
          <input type="checkbox" checked={eqCustomQ} disabled={disabled}
            onChange={e => handleCustomQ(e.target.checked)} />
          <span>Customize Q per band</span>
        </label>
        {eqCustomQ && (
          <>
            <span className="eq-q-hint">
              Higher Q = narrower band, lower = wider. Default {DEFAULT_Q.toFixed(2)}.
            </span>
            <button className="eq-pill eq-pill--ghost" disabled={disabled} onClick={resetQ}>
              <RotateCcw size={12} /> Reset Q
            </button>
          </>
        )}
      </div>

      {/* Sliders */}
      <div className={`eq-board${disabled ? ' eq-board--disabled' : ''}`}>
        <div className="eq-band eq-band--preamp">
          <NumField className="eq-num--accent" value={eqPreamp} min={GAIN_MIN} max={GAIN_MAX}
            disabled={disabled} onCommit={handlePreamp} />
          <VSlider value={eqPreamp} min={GAIN_MIN} max={GAIN_MAX} accent disabled={disabled} onChange={handlePreamp} />
          <div className="eq-band-label eq-band-label--accent">Pre</div>
          {eqCustomQ && <div className="eq-q-spacer" />}
        </div>

        <div className="eq-board-divider" />

        {BAND_LABELS.map((label, i) => (
          <div className="eq-band" key={label}>
            <NumField value={eqGains[i] ?? 0} min={GAIN_MIN} max={GAIN_MAX}
              disabled={disabled} onCommit={v => handleBand(i, v)} />
            <VSlider value={eqGains[i] ?? 0} min={GAIN_MIN} max={GAIN_MAX}
              disabled={disabled} onChange={v => handleBand(i, v)} />
            <div className="eq-band-label">{label}</div>
            {eqCustomQ && (
              <NumField className="eq-num--q" value={eqQs[i] ?? DEFAULT_Q} min={Q_MIN} max={Q_MAX}
                disabled={disabled} onCommit={v => handleBandQ(i, v)} />
            )}
          </div>
        ))}
      </div>

      {/* Reset */}
      <div className="eq-actions">
        <button className="eq-pill" disabled={disabled || isFlat} onClick={resetFlat}>
          <RotateCcw size={12} /> Reset to flat
        </button>
      </div>

      {/* User presets */}
      <div className="eq-preset-group">
        <div className="eq-preset-head">
          <span>My Presets</span>
          {!saving && (
            <button className="eq-pill eq-pill--save" disabled={disabled} onClick={startSave}>
              <Plus size={12} /> Save current
            </button>
          )}
        </div>

        {saving && (
          <div className="eq-save-row">
            <Bookmark size={14} className="eq-save-icon" />
            <input
              className="eq-save-input"
              type="text"
              autoFocus
              placeholder="Preset name…"
              value={draftName}
              maxLength={24}
              onChange={e => setDraftName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmSave();
                if (e.key === 'Escape') cancelSave();
              }}
            />
            <button className="eq-save-btn eq-save-btn--ok" onClick={confirmSave} disabled={!draftName.trim()} title="Save">
              <Check size={14} />
            </button>
            <button className="eq-save-btn" onClick={cancelSave} title="Cancel">
              <X size={14} />
            </button>
          </div>
        )}

        <div className="eq-presets">
          {eqPresets.length === 0 && !saving && (
            <span className="eq-empty">Save your current pre-amp, gains and Q as a reusable preset.</span>
          )}
          {eqPresets.map(p => (
            <div
              key={p.name}
              className={`eq-userpill${isActiveUserPreset(p) ? ' eq-userpill--active' : ''}${disabled ? ' is-disabled' : ''}`}
            >
              <button className="eq-userpill-apply" disabled={disabled} onClick={() => applyUserPreset(p)}>
                {p.name}
              </button>
              <button
                className="eq-userpill-del"
                disabled={disabled}
                title="Delete preset"
                onClick={() => removeEqPreset(p.name)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
