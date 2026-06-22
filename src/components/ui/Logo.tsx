import React from 'react';
import { useThemeStore, THEMES } from '../../stores/themeStore';

interface LogoProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
  squircleColor?: string;
  recordColor?: string;
  accentColor?: string;
}

export default function Logo({
  className,
  squircleColor,
  recordColor = '#222222',
  accentColor = 'var(--accent)',
  ...props
}: LogoProps) {
  const themeId = useThemeStore((s) => s.theme);
  const activeTheme = THEMES.find((t) => t.id === themeId);
  const isLight = activeTheme?.group === 'light';

  // Use the theme's elevated background for the squircle container,
  // matching the card background in settings and layout panels.
  const defaultSquircleColor = isLight ? 'var(--bg-elevated)' : '#222222';
  const finalSquircleColor = squircleColor || defaultSquircleColor;

  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* App Icon Squircle Container Background */}
      <rect
        x="2"
        y="2"
        width="96"
        height="96"
        rx="20"
        ry="20"
        fill={finalSquircleColor}
        style={{ transition: 'fill 0.2s ease' }}
      />

      {/* Vinyl Record Body (Accent Colored) */}
      <circle
        cx="50"
        cy="50"
        r="38"
        fill={accentColor}
      />

      {/* Grooves (Subtle concentric rings) */}
      <circle
        cx="50"
        cy="50"
        r="30"
        stroke={recordColor}
        strokeWidth="1.2"
        fill="none"
        opacity="0.15"
      />
      <circle
        cx="50"
        cy="50"
        r="24"
        stroke={recordColor}
        strokeWidth="1.2"
        fill="none"
        opacity="0.15"
      />
      <circle
        cx="50"
        cy="50"
        r="18"
        stroke={recordColor}
        strokeWidth="1.2"
        fill="none"
        opacity="0.15"
      />

      {/* Specular highlights (Reflection shine) */}
      <path
        d="M 22 22 L 78 78"
        stroke="white"
        strokeWidth="5"
        strokeLinecap="round"
        opacity="0.08"
      />
      <path
        d="M 26 26 L 74 74"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.16"
      />

      {/* Vinyl Record Spindle Area (Dark center) */}
      <circle
        cx="50"
        cy="50"
        r="10"
        fill={recordColor}
      />

      {/* Center Label Dot (Accent color) */}
      <circle
        cx="50"
        cy="50"
        r="3.5"
        fill={accentColor}
      />

      {/* Center Spindle Hole (matches squircle background) */}
      <circle
        cx="50"
        cy="50"
        r="1.2"
        fill={finalSquircleColor}
        style={{ transition: 'fill 0.2s ease' }}
      />
    </svg>
  );
}
