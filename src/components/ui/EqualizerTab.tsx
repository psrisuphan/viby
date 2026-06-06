import { useCallback, useRef, useState, useEffect } from 'react';
import { RotateCcw, SlidersHorizontal, Plus, Check, X, Bookmark, FlaskConical, Wand2 } from 'lucide-react';
import { useSettingsStore, EQ_BAND_COUNT, type EqPreset, type PeqBand } from '../../stores/settingsStore';
import { setEq, setPeq, getTargetCurves, getHeadphoneMeasurements, importHeadphoneMeasurement, deleteHeadphoneMeasurement, readTextFile, type TargetCurve } from '../../utils/tauri';
import { open } from '@tauri-apps/plugin-dialog';
import { useToastStore } from '../../stores/toastStore';
import EqGraph, { getTargetColor } from './EqGraph';
import { runAutoEq, parseAutoEqFilters } from '../../utils/autoeq';
import './EqualizerTab.css';

const BAND_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

const GAIN_MIN = -12;
const GAIN_MAX = 12;
const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const Q_MIN = 0.1;
const Q_MAX = 10;

const FILTER_TYPE_LABELS: Record<number, string> = {
  0: 'Peak',
  1: 'Lo Shelf',
  2: 'Hi Shelf',
  3: 'Lo Pass',
  4: 'Hi Pass',
};

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const gainless = (filterType: number) => filterType === 3 || filterType === 4;

function interpolateDb(points: [number, number][], freq: number): number {
  if (points.length === 0) return 0;
  if (freq <= points[0][0]) return points[0][1];
  if (freq >= points[points.length - 1][0]) return points[points.length - 1][1];

  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid][0] === freq) return points[mid][1];
    if (points[mid][0] < freq) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const p0 = points[low - 1];
  const p1 = points[low];
  if (!p0 || !p1) return 0;
  const t = (freq - p0[0]) / (p1[0] - p0[0]);
  return p0[1] + t * (p1[1] - p0[1]);
}

function VSlider({ value, min, max, disabled, accent, onChange }: {
  value: number; min: number; max: number;
  disabled?: boolean; accent?: boolean;
  onChange: (v: number) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const range = max - min;
  const pct = ((value - min) / range) * 100;
  const centerPct = ((0 - min) / range) * 100;
  const fillBottom = Math.min(pct, centerPct);
  const fillHeight = Math.abs(pct - centerPct);

  const valueFromY = (clientY: number) => {
    const el = areaRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
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

function HSlider({ value, min, max, disabled, onChange }: {
  value: number; min: number; max: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const range = max - min;
  const pct = ((value - min) / range) * 100;
  const centerPct = ((0 - min) / range) * 100;
  const fillLeft = Math.min(pct, centerPct);
  const fillWidth = Math.abs(pct - centerPct);

  const valueFromX = (clientX: number) => {
    const el = areaRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const t = clamp((clientX - rect.left) / rect.width, 0, 1);
    return min + t * range;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    onChange(valueFromX(e.clientX));
    const move = (ev: PointerEvent) => onChange(valueFromX(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`eq-hslider${disabled ? ' is-disabled' : ''}`}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => !disabled && onChange(0)}
      title="Drag to adjust · double-click to reset"
    >
      <div className="eq-hslider-area" ref={areaRef}>
        <div className="eq-hslider-track" />
        <div className="eq-hslider-center" style={{ left: `${centerPct}%` }} />
        <div className="eq-hslider-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }} />
        <div className="eq-hslider-thumb" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}

function NumField({ value, min, max, disabled, onCommit, className }: {
  value: number; min: number; max: number;
  disabled?: boolean; onCommit: (v: number) => void; className?: string;
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

// Drag-to-adjust numeric display. Drag ↕ to change value; click to type; double-click to reset.
// Used for PEQ band parameters where a full-height VSlider won't fit.
function DragNumField({ value, min, max, disabled, onCommit, className, logScale, resetValue, decimals = 2 }: {
  value: number; min: number; max: number;
  disabled?: boolean; onCommit: (v: number) => void;
  className?: string; logScale?: boolean;
  resetValue?: number; decimals?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState('');
  const drag = useRef<{ startY: number; startVal: number; moved: boolean } | null>(null);

  // px of drag to cover the full range (shift = 10× finer)
  const linearSens = (max - min) / 150;
  const logSens    = 1 / 100;   // 100px per octave

  const applyDrag = (startVal: number, dy: number, fine: boolean) => {
    const scale = fine ? 0.1 : 1;
    const next = logScale
      ? startVal * Math.pow(2, dy * logSens * scale)
      : startVal + dy * linearSens * scale;
    return round2(clamp(next, min, max));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startVal: value, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dy = drag.current.startY - e.clientY;   // up = positive = increase
    if (!drag.current.moved && Math.abs(dy) > 3) drag.current.moved = true;
    if (drag.current.moved) onCommit(applyDrag(drag.current.startVal, dy, e.shiftKey));
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    const wasDrag = drag.current.moved;
    drag.current = null;
    if (!wasDrag && !disabled) {
      setDraft(value.toFixed(decimals));
      setEditing(true);
    }
  };

  const commitDraft = () => {
    const parsed = parseFloat(draft);
    if (!isNaN(parsed)) onCommit(round2(clamp(parsed, min, max)));
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        className={`eq-num${className ? ` ${className}` : ''}`}
        type="text"
        inputMode="decimal"
        value={draft}
        onFocus={e => e.currentTarget.select()}
        onChange={e => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={e => {
          if (e.key === 'Enter')  e.currentTarget.blur();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <div
      className={`eq-num eq-num--drag${className ? ` ${className}` : ''}${disabled ? ' eq-num--drag-disabled' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => { if (!disabled && resetValue !== undefined) onCommit(resetValue); }}
      title="Drag ↕ · shift for fine · click to type · double-click to reset"
    >
      {value.toFixed(decimals)}
    </div>
  );
}

// Per-band hue palette (cycles through 8 distinct hues)
const BAND_HUES = [200, 160, 280, 40, 340, 100, 260, 20];

function PeqBandRow({ band, index, disabled, canRemove, onChange, onRemove }: {
  band: PeqBand; index: number; disabled: boolean; canRemove: boolean;
  onChange: (patch: Partial<PeqBand>) => void;
  onRemove: () => void;
}) {
  const noGain = gainless(band.filterType);
  const hue = BAND_HUES[index % BAND_HUES.length];
  const accentColor = `hsl(${hue}, 70%, 60%)`;

  return (
    <div
      className={`eq-band-row${disabled ? ' is-disabled' : ''}${!band.enabled ? ' eq-band-row--bypassed' : ''}`}
    >
      {/* Color dot & Band number */}
      <div className="eq-band-row-meta">
        <span className="eq-band-row-dot" style={{ background: accentColor }} />
        <span className="eq-band-row-num" style={{ color: accentColor }}>{index + 1}</span>
      </div>

      {/* Type selector */}
      <select
        className="eq-band-row-type"
        value={band.filterType}
        disabled={disabled || !band.enabled}
        onChange={e => onChange({ filterType: Number(e.target.value) as PeqBand['filterType'] })}
      >
        {Object.entries(FILTER_TYPE_LABELS).map(([k, label]) => (
          <option key={k} value={k}>{label}</option>
        ))}
      </select>

      {/* Freq */}
      <DragNumField value={band.freq} min={FREQ_MIN} max={FREQ_MAX}
        disabled={disabled || !band.enabled} onCommit={v => onChange({ freq: v })}
        logScale decimals={0} className="eq-band-row-val eq-peq-val-freq" />

      {/* Gain */}
      <DragNumField value={noGain ? 0 : band.gain} min={GAIN_MIN} max={GAIN_MAX}
        disabled={disabled || !band.enabled || noGain}
        onCommit={v => onChange({ gain: v })} resetValue={0}
        className={`eq-band-row-val eq-peq-val-gain${noGain ? ' eq-peq-dimmed' : ''}`} />

      {/* Q */}
      <DragNumField value={band.q} min={Q_MIN} max={Q_MAX}
        disabled={disabled || !band.enabled}
        onCommit={v => onChange({ q: v })} resetValue={1}
        className="eq-band-row-val eq-peq-val-q" />

      {/* Bypass */}
      <div className="eq-band-row-bypass-wrap">
        <input
          type="checkbox"
          className="eq-peq-check"
          checked={band.enabled}
          disabled={disabled}
          onChange={e => onChange({ enabled: e.target.checked })}
          title="Enable / bypass"
        />
      </div>

      {/* Remove */}
      <button
        className="eq-band-row-remove"
        disabled={disabled || !canRemove}
        onClick={onRemove}
        title="Remove"
      ><X size={11} /></button>
    </div>
  );
}

interface EqualizerTabProps {
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

export default function EqualizerTab({ isExpanded = false, onToggleExpand }: EqualizerTabProps) {
  const {
    eqEnabled, setEqEnabled,
    eqMode, setEqMode,
    eqPreamp, setEqPreamp,
    eqGains, setEqGains,
    eqPresets, addEqPreset, removeEqPreset,
    peqBands, setPeqBand, setPeqBands, addPeqBand, removePeqBand,
  } = useSettingsStore();

  const [saving, setSaving] = useState(false);
  const [draftName, setDraftName] = useState('');

  const [targets, setTargets] = useState<TargetCurve[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [measurements, setMeasurements] = useState<TargetCurve[]>([]);
  const [selectedMeasurements, setSelectedMeasurements] = useState<string[]>([]);

  useEffect(() => {
    // 1. Load built-in Reference Targets
    getTargetCurves()
      .then(res => {
        const normalized = res.map(c => {
          const sortedPoints = [...c.points].sort((a, b) => a[0] - b[0]);
          const offset = interpolateDb(sortedPoints, 1000);
          const points = sortedPoints.map(([f, db]) => [f, db - offset] as [number, number]);
          return { name: c.name, points };
        });
        setTargets(normalized);
      })
      .catch(err => console.error('Failed to load target curves:', err));

    // 2. Load Headphone Measurements
    getHeadphoneMeasurements()
      .then(res => {
        const normalized = res.map(c => {
          const sortedPoints = [...c.points].sort((a, b) => a[0] - b[0]);
          const offset = interpolateDb(sortedPoints, 1000);
          const points = sortedPoints.map(([f, db]) => [f, db - offset] as [number, number]);
          return { name: c.name, points };
        });
        setMeasurements(normalized);
      })
      .catch(err => console.error('Failed to load headphone measurements:', err));
  }, []);

  const toggleTarget = (name: string) => {
    setSelectedTargets(prev =>
      prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
    );
  };

  const toggleMeasurement = (name: string) => {
    setSelectedMeasurements(prev =>
      prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
    );
  };

  const handleImportMeasurement = async () => {
    try {
      const selected = await open({
        filters: [{
          name: 'Frequency Response',
          extensions: ['txt', 'csv']
        }],
        multiple: false,
        title: 'Select Frequency Response File'
      });
      
      if (!selected) return;
      
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath) return;

      const newCurve = await importHeadphoneMeasurement(filePath);
      
      const sortedPoints = [...newCurve.points].sort((a, b) => a[0] - b[0]);
      const offset = interpolateDb(sortedPoints, 1000);
      const points = sortedPoints.map(([f, db]) => [f, db - offset] as [number, number]);
      
      const curveWithPoints: TargetCurve = {
        name: newCurve.name,
        points
      };

      setMeasurements(prev => {
        const next = [...prev.filter(t => t.name !== curveWithPoints.name), curveWithPoints];
        next.sort((a, b) => a.name.localeCompare(b.name));
        return next;
      });

      setSelectedMeasurements(prev => [...prev.filter(name => name !== curveWithPoints.name), curveWithPoints.name]);
      useToastStore.getState().addToast(`Imported headphone measurement: ${newCurve.name}`, 'success');
    } catch (err: any) {
      console.error(err);
      useToastStore.getState().addToast(err.toString() || 'Failed to import curve', 'error');
    }
  };

  const handleDeleteMeasurement = async (name: string) => {
    try {
      await deleteHeadphoneMeasurement(name);
      setMeasurements(prev => prev.filter(t => t.name !== name));
      setSelectedMeasurements(prev => prev.filter(t => t !== name));
      useToastStore.getState().addToast(`Deleted headphone measurement: ${name}`, 'success');
    } catch (err: any) {
      console.error(err);
      useToastStore.getState().addToast(err.toString() || 'Failed to delete curve', 'error');
    }
  };

  const handleAutoEq = () => {
    if (selectedTargets.length !== 1 || selectedMeasurements.length !== 1) return;
    const targetName = selectedTargets[0];
    const measurementName = selectedMeasurements[0];

    const targetCurve = targets.find(t => t.name === targetName);
    const measurementCurve = measurements.find(m => m.name === measurementName);

    if (!targetCurve || !measurementCurve) return;

    try {
      const result = runAutoEq(measurementCurve, targetCurve, peqBands.length);
      
      setPeqBands(result.bands);
      setEqPreamp(result.preamp);
      pushPeq({ bands: result.bands, preamp: result.preamp });

      useToastStore.getState().addToast(`AutoEQ: Matched ${measurementName} to ${targetName}!`, 'success');
    } catch (err: any) {
      console.error(err);
      useToastStore.getState().addToast('AutoEQ optimization failed.', 'error');
    }
  };

  const handleImportEq = async () => {
    try {
      const selected = await open({
        filters: [{
          name: 'AutoEQ Filters',
          extensions: ['txt']
        }],
        multiple: false,
        title: 'Select AutoEQ Export File'
      });

      if (!selected) return;

      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath) return;

      const fileContent = await readTextFile(filePath);
      const parsed = parseAutoEqFilters(fileContent);

      if (parsed.bands.length === 0) {
        throw new Error('No valid filters found in the file.');
      }

      setPeqBands(parsed.bands);
      setEqPreamp(parsed.preamp);
      pushPeq({ bands: parsed.bands, preamp: parsed.preamp });

      const fileName = filePath.split(/[/\\]/).pop() || 'filters.txt';
      useToastStore.getState().addToast(`Imported ${parsed.bands.length} filters from ${fileName}!`, 'success');
    } catch (err: any) {
      console.error(err);
      useToastStore.getState().addToast(err.toString() || 'Failed to import EQ filters', 'error');
    }
  };

  const pushGeq = useCallback((o?: Partial<{ enabled: boolean; preamp: number; gains: number[] }>) => {
    setEq(o?.enabled ?? eqEnabled, o?.preamp ?? eqPreamp, o?.gains ?? eqGains);
  }, [eqEnabled, eqPreamp, eqGains]);

  const pushPeq = useCallback((o?: Partial<{ enabled: boolean; preamp: number; bands: PeqBand[] }>) => {
    const bands = o?.bands ?? peqBands;
    setPeq(o?.enabled ?? eqEnabled, o?.preamp ?? eqPreamp, bands.map(b => ({
      enabled: b.enabled, filter_type: b.filterType, freq: b.freq, gain: b.gain, q: b.q,
    })));
  }, [eqEnabled, eqPreamp, peqBands]);

  const handleModeChange = (mode: 'graphic' | 'parametric') => {
    setEqMode(mode);
    if (mode === 'parametric') {
      pushPeq({ enabled: eqEnabled });
    } else {
      pushGeq({ enabled: eqEnabled });
    }
  };

  const handleEnabled = (v: boolean) => {
    setEqEnabled(v);
    if (eqMode === 'parametric') pushPeq({ enabled: v });
    else pushGeq({ enabled: v });
  };

  const handlePreamp = (v: number) => {
    const r = round2(v);
    setEqPreamp(r);
    if (eqMode === 'parametric') pushPeq({ preamp: r });
    else pushGeq({ preamp: r });
  };

  const handleBand = (index: number, value: number) => {
    const next = eqGains.slice();
    next[index] = round2(value);
    setEqGains(next);
    pushGeq({ gains: next });
  };

  const handlePeqBand = (index: number, patch: Partial<PeqBand>) => {
    setPeqBand(index, patch);
    const next = peqBands.slice();
    next[index] = { ...next[index], ...patch };
    pushPeq({ bands: next });
  };

  const handlePeqAdd = () => {
    addPeqBand();
    // pushPeq will be called on next render via the updated peqBands;
    // we call it immediately with the new band appended.
    const next = [...peqBands, { enabled: true, filterType: 0 as const, freq: 1000, gain: 0, q: 1.0 }];
    pushPeq({ bands: next });
  };

  const handlePeqRemove = (index: number) => {
    const next = peqBands.filter((_, i) => i !== index);
    removePeqBand(index);
    pushPeq({ bands: next });
  };

  const resetFlat = () => {
    if (eqMode === 'parametric') {
      const next = peqBands.map(b => ({ ...b, gain: 0 }));
      next.forEach((b, i) => setPeqBand(i, b));
      setEqPreamp(0);
      pushPeq({ preamp: 0, bands: next });
    } else {
      const gains = Array(EQ_BAND_COUNT).fill(0);
      setEqGains(gains);
      setEqPreamp(0);
      pushGeq({ gains, preamp: 0 });
    }
  };

  const isFlat = eqMode === 'parametric'
    ? eqPreamp === 0 && peqBands.every(b => b.gain === 0)
    : eqPreamp === 0 && eqGains.every(g => g === 0);

  const applyUserPreset = (p: EqPreset) => {
    setEqPreamp(p.preamp);
    setEqGains(p.gains.slice());
    setEqMode('graphic');
    pushGeq({ preamp: p.preamp, gains: p.gains });
  };

  const isActiveUserPreset = (p: EqPreset) =>
    eqMode === 'graphic' &&
    Math.abs(p.preamp - eqPreamp) < 0.05 &&
    p.gains.every((g, i) => Math.abs((eqGains[i] ?? 0) - g) < 0.05);

  const startSave = () => { setDraftName(''); setSaving(true); };
  const cancelSave = () => { setSaving(false); setDraftName(''); };
  const confirmSave = () => {
    const name = draftName.trim();
    if (!name) return;
    addEqPreset({ name, preamp: eqPreamp, gains: eqGains.slice() });
    setSaving(false);
    setDraftName('');
  };

  const disabled = !eqEnabled;
  const isPeq = eqMode === 'parametric';
  const geqDisabled = !eqEnabled || isPeq;
  const showPeqWorkspace = isPeq && isExpanded;

  return (
    <div className={`settings-section-list${showPeqWorkspace ? ' settings-section-list--peq' : ''}`}>

      {/* Master toggle — hidden in PEQ full-page mode */}
      {!showPeqWorkspace && (
        <div className="eq-header">
          <div className="eq-header-icon"><SlidersHorizontal size={18} /></div>
          <div className="eq-header-text">
            <div className="eq-header-title">Equalizer</div>
            <div className="eq-header-sub">Shape the sound with a 10-band equalizer.</div>
          </div>
          <label className="eq-switch">
            <input type="checkbox" checked={eqEnabled} onChange={e => handleEnabled(e.target.checked)} />
            <span className="eq-switch-track"><span className="eq-switch-thumb" /></span>
          </label>
        </div>
      )}

      {/* EQ Mode Toggle Row */}
      {!showPeqWorkspace && (
        <div className="eq-mode-row">
          <div className="eq-mode-selector">
            <button
              className={`eq-mode-btn${!isPeq ? ' active' : ''}`}
              onClick={() => handleModeChange('graphic')}
            >
              Graphic EQ
            </button>
            <button
              className={`eq-mode-btn${isPeq ? ' active' : ''}`}
              onClick={() => handleModeChange('parametric')}
            >
              Parametric EQ
            </button>
          </div>

          {isPeq && (
            <button
              className="eq-peq-config-btn"
              onClick={onToggleExpand}
              title="Configure Parametric EQ filters and view response graph"
            >
              <FlaskConical size={14} />
              <span>Configure PEQ</span>
            </button>
          )}
        </div>
      )}

      {showPeqWorkspace ? (
        <div className={`eq-peq-workspace${disabled ? ' eq-board--disabled' : ''}`}>

          {/* ── LEFT: filter list ── */}
          <div className="eq-peq-left">
            <div className="eq-peq-left-header">
              <span className="eq-peq-panel-label">Filters</span>
              <div className="eq-peq-right-actions">
                <button
                  className="eq-pill eq-pill--autoeq"
                  disabled={disabled || selectedTargets.length !== 1 || selectedMeasurements.length !== 1}
                  onClick={handleAutoEq}
                  title={
                    selectedTargets.length !== 1 || selectedMeasurements.length !== 1
                      ? "Select exactly one Reference Curve and one Headphone Measurement to run AutoEQ"
                      : "Automatically fit parametric EQ bands to the target curve"
                  }
                >
                  <Wand2 size={12} /> AutoEQ
                </button>
                <button
                  className="eq-pill"
                  disabled={disabled}
                  onClick={handleImportEq}
                  title="Import EQ settings from an AutoEQ filter settings file (.txt)"
                >
                  <Plus size={12} /> Import EQ
                </button>
                <button className="eq-pill" disabled={disabled || isFlat} onClick={resetFlat}>
                  <RotateCcw size={12} /> Reset gains
                </button>
              </div>
            </div>

            {/* Preamp horizontal slider row */}
            <div className="eq-peq-preamp-row">
              <span className="eq-peq-preamp-row-label">Pre-amp</span>
              <HSlider value={eqPreamp} min={GAIN_MIN} max={GAIN_MAX} disabled={disabled} onChange={handlePreamp} />
              <div className="eq-peq-preamp-val-wrap">
                <DragNumField value={eqPreamp} min={GAIN_MIN} max={GAIN_MAX}
                  disabled={disabled} onCommit={handlePreamp}
                  resetValue={0} className="eq-num--accent" />
                <span className="eq-peq-unit">dB</span>
              </div>
            </div>

            <div className="eq-peq-list-header">
              <span className="eq-peq-list-hdr-band">Band</span>
              <span className="eq-peq-list-hdr-type">Type</span>
              <span className="eq-peq-list-hdr-freq">Freq (Hz)</span>
              <span className="eq-peq-list-hdr-gain">Gain (dB)</span>
              <span className="eq-peq-list-hdr-q">Q</span>
              <span className="eq-peq-list-hdr-bypass">Bypass</span>
              <span className="eq-peq-list-hdr-remove" />
            </div>

            <div className="eq-peq-band-list">
              {peqBands.map((band, i) => (
                <PeqBandRow key={i} band={band} index={i} disabled={disabled}
                  canRemove={peqBands.length > 1}
                  onChange={patch => handlePeqBand(i, patch)}
                  onRemove={() => handlePeqRemove(i)} />
              ))}

              {/* Row-sized Plus symbol button for adding filters */}
              <button
                className="eq-band-row-add"
                disabled={disabled}
                onClick={handlePeqAdd}
                title="Add new filter band"
              >
                <Plus size={16} />
              </button>
            </div>

            {/* ── Headphone Measurements Management (Bottom Left) ── */}
            <div className="eq-peq-measurements-manager">
              <div className="eq-peq-measurements-manager-header">
                <span className="eq-peq-panel-label">Headphone Measurements</span>
                <button
                  className="eq-pill eq-pill--save"
                  onClick={handleImportMeasurement}
                  disabled={disabled}
                  title="Import headphone frequency response curve (.txt or .csv)"
                >
                  <Plus size={12} />
                  <span>Import</span>
                </button>
              </div>

              <div className="eq-peq-measurements-list">
                {measurements.length === 0 ? (
                  <span className="eq-empty" style={{ fontStyle: 'italic', fontSize: '11px' }}>
                    No measurements loaded.
                  </span>
                ) : (
                  measurements.map(m => {
                    const isSel = selectedMeasurements.includes(m.name);
                    const color = 'hsl(28, 90%, 60%)'; // Warm orange/amber for headphone measurements
                    return (
                      <div
                        key={m.name}
                        className={`eq-measurement-manager-row${isSel ? ' active' : ''}`}
                      >
                        <button
                          className="eq-measurement-manager-toggle"
                          onClick={() => toggleMeasurement(m.name)}
                          disabled={disabled}
                        >
                          <span className="eq-measurement-manager-dot" style={{ background: color }} />
                          <span className="eq-measurement-manager-name" title={m.name}>{m.name}</span>
                        </button>
                        <button
                          className="eq-measurement-manager-delete-btn"
                          onClick={() => handleDeleteMeasurement(m.name)}
                          disabled={disabled}
                          title="Delete headphone measurement"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* ── DIVIDER ── */}
          <div className="eq-peq-vsplit" />

          {/* ── RIGHT: graph ── */}
          <div className="eq-peq-right">
            <div className="eq-peq-right-top">
              <span className="eq-peq-panel-label">Frequency Response</span>
            </div>
            <div className="eq-peq-graph-wrap">
              <EqGraph mode="parametric" enabled={eqEnabled} preamp={eqPreamp} bands={peqBands}
                targetCurves={targets.filter(t => selectedTargets.includes(t.name))}
                measurementCurves={measurements.filter(m => selectedMeasurements.includes(m.name))} />
            </div>

            {/* Target Curve Selection Bar */}
            <div className="eq-target-selector-bar">
              {targets.length === 0 && (
                <span className="eq-empty eq-empty--targets" style={{ fontSize: '0.72rem', fontStyle: 'italic', color: 'var(--text-tertiary)' }}>
                  No target curves loaded.
                </span>
              )}

              {/* IE Target curves group */}
              {targets.some(t => t.name.toLowerCase().includes('ie')) && (
                <div className="eq-target-group">
                  <span className="eq-target-group-label">Reference (IE):</span>
                  <div className="eq-target-group-buttons">
                    {targets
                      .filter(t => t.name.toLowerCase().includes('ie'))
                      .map(t => {
                        const isSel = selectedTargets.includes(t.name);
                        const { glowClass } = getTargetColor(t.name);
                        return (
                          <button
                            key={t.name}
                            className={`eq-target-btn${isSel ? ` is-selected ${glowClass}` : ''}`}
                            onClick={() => toggleTarget(t.name)}
                            disabled={disabled}
                          >
                            {t.name}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Vertical Divider */}
              {targets.some(t => t.name.toLowerCase().includes('ie')) &&
               targets.some(t => t.name.toLowerCase().includes('oe')) && (
                <div className="eq-target-vdivider" />
              )}

              {/* OE Target curves group */}
              {targets.some(t => t.name.toLowerCase().includes('oe')) && (
                <div className="eq-target-group">
                  <span className="eq-target-group-label">Preference (OE):</span>
                  <div className="eq-target-group-buttons">
                    {targets
                      .filter(t => t.name.toLowerCase().includes('oe'))
                      .map(t => {
                        const isSel = selectedTargets.includes(t.name);
                        const { glowClass } = getTargetColor(t.name);
                        return (
                          <button
                            key={t.name}
                            className={`eq-target-btn${isSel ? ` is-selected ${glowClass}` : ''}`}
                            onClick={() => toggleTarget(t.name)}
                            disabled={disabled}
                          >
                            {t.name}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Other/Custom Target curves group */}
              {targets.some(t => !t.name.toLowerCase().includes('ie') && !t.name.toLowerCase().includes('oe')) && (
                <>
                  {(targets.some(t => t.name.toLowerCase().includes('ie')) ||
                    targets.some(t => t.name.toLowerCase().includes('oe'))) && (
                    <div className="eq-target-vdivider" />
                  )}
                  <div className="eq-target-group">
                    <span className="eq-target-group-label">Other:</span>
                    <div className="eq-target-group-buttons">
                      {targets
                        .filter(t => !t.name.toLowerCase().includes('ie') && !t.name.toLowerCase().includes('oe'))
                        .map(t => {
                          const isSel = selectedTargets.includes(t.name);
                          const { glowClass } = getTargetColor(t.name);
                          return (
                            <button
                              key={t.name}
                              className={`eq-target-btn${isSel ? ` is-selected ${glowClass}` : ''}`}
                              onClick={() => toggleTarget(t.name)}
                              disabled={disabled}
                            >
                              {t.name}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* GEQ: sliders only, no graph */}
          <div className={`eq-board${geqDisabled ? ' eq-board--disabled' : ''}`}>
            <div className="eq-band eq-band--preamp">
              <NumField className="eq-num--accent" value={eqPreamp} min={GAIN_MIN} max={GAIN_MAX}
                disabled={geqDisabled} onCommit={handlePreamp} />
              <VSlider value={eqPreamp} min={GAIN_MIN} max={GAIN_MAX} accent
                disabled={geqDisabled} onChange={handlePreamp} />
              <div className="eq-band-label eq-band-label--accent">Pre</div>
            </div>
            <div className="eq-board-divider" />
            {BAND_LABELS.map((label, i) => (
              <div className="eq-band" key={label}>
                <NumField value={eqGains[i] ?? 0} min={GAIN_MIN} max={GAIN_MAX}
                  disabled={geqDisabled} onCommit={v => handleBand(i, v)} />
                <VSlider value={eqGains[i] ?? 0} min={GAIN_MIN} max={GAIN_MAX}
                  disabled={geqDisabled} onChange={v => handleBand(i, v)} />
                <div className="eq-band-label">{label}</div>
              </div>
            ))}
          </div>

          <div className="eq-actions">
            <button className="eq-pill" disabled={geqDisabled || isFlat} onClick={resetFlat}>
              <RotateCcw size={12} /> Reset to flat
            </button>
          </div>

          {/* Presets */}
          <div className="eq-preset-group">
            <div className="eq-preset-head">
              <span>My Presets</span>
              {!saving && (
                <button className="eq-pill eq-pill--save" disabled={geqDisabled} onClick={startSave}>
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
                <button className="eq-save-btn eq-save-btn--ok" onClick={confirmSave}
                  disabled={!draftName.trim()} title="Save"><Check size={14} /></button>
                <button className="eq-save-btn" onClick={cancelSave} title="Cancel">
                  <X size={14} />
                </button>
              </div>
            )}

            <div className="eq-presets">
              {eqPresets.length === 0 && !saving && (
                <span className="eq-empty">Save your current pre-amp and gains as a reusable preset.</span>
              )}
              {eqPresets.map(p => (
                <div key={p.name}
                  className={`eq-userpill${isActiveUserPreset(p) ? ' eq-userpill--active' : ''}${geqDisabled ? ' is-disabled' : ''}`}
                >
                  <button className="eq-userpill-apply" disabled={geqDisabled} onClick={() => applyUserPreset(p)}>
                    {p.name}
                  </button>
                  <button className="eq-userpill-del" disabled={geqDisabled} title="Delete preset"
                    onClick={() => removeEqPreset(p.name)}><X size={12} /></button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
