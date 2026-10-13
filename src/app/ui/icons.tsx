// The icons of the interface: line drawings on a 16 × 16 grid, in the colour of the text around them.

import type { SVGAttributes } from 'react';

import './controls.css';

const PATHS = {
  'check': 'M3.5 8.5l3 3 6-7',
  'chevron-down': 'M4 6l4 4 4-4',
  'chevron-right': 'M6 4l4 4-4 4',
  'chevron-up': 'M4 10l4-4 4 4',
  'close': 'M4 4l8 8M12 4l-8 8',
  'search': 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM11 11l3 3',
  'plus': 'M8 3v10M3 8h10',
  'minus': 'M3 8h10',
  'more': 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  'pause': 'M5.5 3.5v9M10.5 3.5v9',
  'play': 'M5 3.5l7 4.5-7 4.5z',
  'stop': 'M4.5 4.5h7v7h-7z',
  'reset': 'M3 8a5 5 0 1 0 1.6-3.7M3 3v3h3',
  'warning': 'M8 2.5l6 10.5H2zM8 6.5v3M8 11.2v.1',
  'error': 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 5v3.5M8 10.8v.1',
  'info': 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 7.5V11M8 5.2v.1',
  'folder': 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  'file': 'M4 2h5l3 3v9H4zM9 2v3h3',
  'save': 'M3 3h8l2 2v8H3zM5 3v3.5h5V3M5 13V9.5h6V13',
  'settings': 'M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6M10 3.5v3M6 9.5v3',
  'lock': 'M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
  'eye': 'M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4zM8 9.7a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z',
  'fit': 'M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3',
  'trash': 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  'dice': 'M3 3h10v10H3zM6 6h.01M10 6h.01M8 8h.01M6 10h.01M10 10h.01',
  'link': 'M6.5 9.5l3-3M5 8l-1 1a2.1 2.1 0 0 0 3 3l1-1M8 5l1-1a2.1 2.1 0 0 1 3 3l-1 1',
  'grip': 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01',
  'build': 'M8 2l5 2.5v7L8 14l-5-2.5v-7zM3 4.5L8 7l5-2.5M8 7v7',
  'chip': 'M5 5h6v6H5zM7 2.5V5M9 2.5V5M7 11v2.5M9 11v2.5M2.5 7H5M2.5 9H5M11 7h2.5M11 9h2.5',
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon(props: { readonly name: IconName } & SVGAttributes<SVGSVGElement>) {
  const { name, className, ...rest } = props;
  return (
    <svg className={className ? `og-icon ${className}` : 'og-icon'} viewBox="0 0 16 16" aria-hidden="true" data-icon={name} {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
