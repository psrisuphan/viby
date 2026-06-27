import React from 'react';
import logoUrl from '../../../assets/logo.png';

type LogoProps = Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  'children' | 'src'
>;

const recoloredLogos = new Map<string, Promise<string>>();

function cssColorToRgb(color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;

  const context = canvas.getContext('2d');
  if (!context) return null;

  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);

  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
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
      const accentRgb = cssColorToRgb(accent);
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

    const updateLogo = () => {
      recolorLogo(getAccent()).then((nextSrc) => {
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
