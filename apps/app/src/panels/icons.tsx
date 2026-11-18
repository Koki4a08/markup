import type { ReactNode } from 'react';

/** One authored icon set: 16px grid, 1.5px stroke, round caps. */
const Svg = ({ children, label }: { children: ReactNode; label?: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} aria-label={label}>
    {children}
  </svg>
);

export const icons = {
  move: (
    <Svg>
      <path d="M4 2.5 12.5 8 8.6 9.1l2.2 3.9-1.5.8-2.2-3.9L4 12.5Z" />
    </Svg>
  ),
  frame: (
    <Svg>
      <path d="M5 1.5v13M11 1.5v13M1.5 5h13M1.5 11h13" />
    </Svg>
  ),
  rect: (
    <Svg>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
    </Svg>
  ),
  text: (
    <Svg>
      <path d="M3 3.5h10M8 3.5v9.5M6 13h4" />
    </Svg>
  ),
  hand: (
    <Svg>
      <path d="M5 8.5V4a1 1 0 0 1 2 0v3.5M7 7V3a1 1 0 0 1 2 0v4M9 7V3.5a1 1 0 0 1 2 0V8M11 6.5a1 1 0 0 1 2 0v3a4.5 4.5 0 0 1-4.5 4.5h-.7a4 4 0 0 1-3.2-1.6L2.8 10a1 1 0 0 1 1.6-1.2L5 9.5" />
    </Svg>
  ),
  image: (
    <Svg>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="m2.5 11.5 3.5-3.5 3 3 2-2 2.5 2.5" />
    </Svg>
  ),
  svg: (
    <Svg>
      <path d="M3 12.5c2-6 8-6 10-9" />
      <circle cx="3" cy="12.5" r="1" />
      <circle cx="13" cy="3.5" r="1" />
    </Svg>
  ),
  eye: (
    <Svg>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  ),
  eyeOff: (
    <Svg>
      <path d="M2 2l12 12M6.5 4a6 6 0 0 1 1.5-.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.8 2.3M4 5.4A11 11 0 0 0 1.5 8S4 12.5 8 12.5a6 6 0 0 0 2.4-.5" />
    </Svg>
  ),
  lock: (
    <Svg>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  ),
  unlock: (
    <Svg>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" />
    </Svg>
  ),
  chevron: (
    <Svg>
      <path d="m6 4 4 4-4 4" />
    </Svg>
  ),
  page: (
    <Svg>
      <path d="M4 1.5h5.5L12 4v10.5H4Z" />
    </Svg>
  ),
  close: (
    <Svg>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  ),
  plus: (
    <Svg>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  ),
  home: (
    <Svg>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </Svg>
  ),
  folder: (
    <Svg>
      <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3h-4a1 1 0 0 0-1 1.5Z" />
    </Svg>
  ),
  file: (
    <Svg>
      <path d="M4 1.5h5.5L12 4v10.5H4Z" />
      <path d="M9.5 1.5V4H12" />
    </Svg>
  ),
  archive: (
    <Svg>
      <rect x="1.5" y="2.5" width="13" height="3" rx="0.5" />
      <path d="M2.5 5.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-7M6.5 8.5h3" />
    </Svg>
  ),
  search: (
    <Svg>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </Svg>
  ),
  more: (
    <Svg>
      <circle cx="3.5" cy="8" r="0.75" />
      <circle cx="8" cy="8" r="0.75" />
      <circle cx="12.5" cy="8" r="0.75" />
    </Svg>
  ),
  trash: (
    <Svg>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4" />
    </Svg>
  ),
  comment: (
    <Svg>
      <path d="M3 3h10a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    </Svg>
  ),
};
