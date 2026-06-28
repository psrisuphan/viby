import React from 'react';
import logoUrl from '../../../assets/logo.png';

type LogoProps = Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  'children' | 'src'
>;

const recoloredLogos = new Map<string, Promise<string>>();

function cssColorToRgb(color: string) {
  if (!color) return null;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;

  const context = canvas.getContext('2d');
  if (!context) return null;

  // Set default fillStyle to transparent to detect invalid colors
  context.fillStyle = 'rgba(0, 0, 0, 0)';
  context.fillRect(0, 0, 1, 1);

  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);

  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  if (a === 0) {
    // Invalid/unresolved color (alpha remains 0)
    return null;
  }
  return { r, g, b };
}

function recolorLogo(accent: string) {
  const cached = recoloredLogos.get(accent);
  if (cached) return cached;

  const recolored = new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;

      const context = canvas.getContext('2d', { willReadFrequently: true });
      const accentRgb = cssColorToRgb(accent) || cssColorToRgb('hsl(125, 75%, 70%)');
      if (!context || !accentRgb) {
        resolve(logoUrl);
        return;
      }

      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const { data } = imageData;

      for (let index = 0; index < data.length; index += 4) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const a = data[index + 3];

        if (a > 0 && g > 120 && g > r * 1.25 && g > b * 1.25) {
          data[index] = accentRgb.r;
          data[index + 1] = accentRgb.g;
          data[index + 2] = accentRgb.b;
        }
      }

      context.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => resolve(logoUrl);
    image.src = logoUrl;
  });

  recoloredLogos.set(accent, recolored);
  return recolored;
}

function getAccent() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue('--accent')
    .trim();
}

export default function Logo({ className, alt = '', ...props }: LogoProps) {
  const [src, setSrc] = React.useState(logoUrl);

  React.useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    const updateLogo = () => {
      const accent = getAccent();
      if (!accent) {
        // Styles/theme variables might not be loaded yet. Display the default green logo
        // as a placeholder, and queue a retry shortly.
        recolorLogo('hsl(125, 75%, 70%)').then((nextSrc) => {
          if (!cancelled) setSrc(nextSrc);
        });
        timeoutId = window.setTimeout(updateLogo, 100);
        return;
      }

      recolorLogo(accent).then((nextSrc) => {
        if (!cancelled) setSrc(nextSrc);
      });
    };

    updateLogo();

    const observer = new MutationObserver(updateLogo);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      observer.disconnect();
    };
  }, []);

  return (
    <img
      {...props}
      src={src}
      alt={alt}
      className={className ? `viby-logo ${className}` : 'viby-logo'}
    />
  );
}
