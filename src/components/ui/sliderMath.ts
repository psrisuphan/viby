export function normalizeSliderValue(
  value: number,
  min: number,
  max: number,
  step: number,
) {
  const safeStep = step > 0 ? step : 1;
  const clamped = Math.min(max, Math.max(min, value));
  const stepped = min + Math.round((clamped - min) / safeStep) * safeStep;
  const precision = Math.min(
    8,
    Math.max(decimalPlaces(min), decimalPlaces(safeStep)),
  );
  return Math.min(max, Math.max(min, Number(stepped.toFixed(precision))));
}

function decimalPlaces(value: number) {
  const text = String(value);
  const decimalIndex = text.indexOf(".");
  return decimalIndex < 0 ? 0 : text.length - decimalIndex - 1;
}

export function getSliderKeyboardValue(
  key: string,
  current: number,
  min: number,
  max: number,
  step: number,
  pageStep: number,
) {
  let next: number;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      next = current + step;
      break;
    case "ArrowLeft":
    case "ArrowDown":
      next = current - step;
      break;
    case "PageUp":
      next = current + pageStep;
      break;
    case "PageDown":
      next = current - pageStep;
      break;
    case "Home":
      next = min;
      break;
    case "End":
      next = max;
      break;
    default:
      return null;
  }
  return normalizeSliderValue(next, min, max, step);
}
