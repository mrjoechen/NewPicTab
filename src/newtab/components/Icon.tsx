import type { SVGProps } from 'react';

export type IconName =
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-up'
  | 'brush'
  | 'check'
  | 'chevrons-up-down'
  | 'clock'
  | 'close'
  | 'cloud'
  | 'copy'
  | 'database'
  | 'edit'
  | 'eye'
  | 'eye-off'
  | 'folder'
  | 'globe'
  | 'image'
  | 'info'
  | 'key'
  | 'language'
  | 'location'
  | 'plus'
  | 'refresh'
  | 'save'
  | 'search'
  | 'settings'
  | 'sparkle'
  | 'test'
  | 'trash';

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    {iconPath(name)}
  </svg>;
}

function iconPath(name: IconName) {
  switch (name) {
    case 'arrow-down': return <path d="M12 5v14m0 0 5-5m-5 5-5-5" />;
    case 'arrow-left': return <path d="M19 12H5m0 0 5-5m-5 5 5 5" />;
    case 'arrow-up': return <path d="M12 19V5m0 0 5 5m-5-5-5 5" />;
    case 'brush': return <><path d="M4 20c3 0 5-1.3 5-4" /><path d="m9 16 8.8-8.8a2.4 2.4 0 0 0-3.4-3.4L5.6 12.6" /><path d="M5.6 12.6 9 16" /></>;
    case 'check': return <path d="m5 12 4 4L19 6" />;
    case 'chevrons-up-down': return <><path d="m7 8 5-5 5 5" /><path d="m7 16 5 5 5-5" /></>;
    case 'clock': return <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>;
    case 'close': return <path d="M6 6l12 12M18 6 6 18" />;
    case 'cloud': return <path d="M7 18h10.2a4.3 4.3 0 0 0 .5-8.6A6.2 6.2 0 0 0 5.8 11 3.5 3.5 0 0 0 7 18Z" />;
    case 'copy': return <><rect x="8" y="8" width="10" height="10" rx="2" /><path d="M6 14H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" /></>;
    case 'database': return <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" /><path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" /></>;
    case 'edit': return <><path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>;
    case 'eye': return <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>;
    case 'eye-off': return <><path d="m3 3 18 18" /><path d="M10.6 10.6a2.5 2.5 0 0 0 2.8 2.8" /><path d="M7.1 7.5C4.2 9.1 2.5 12 2.5 12s3.5 6 9.5 6c1.6 0 3-.4 4.2-1" /><path d="M13.8 6.2C18.6 7 21.5 12 21.5 12s-.8 1.3-2.2 2.7" /></>;
    case 'folder': return <><path d="M3.5 6.5h6l2 2h9v8.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V6.5Z" /><path d="M3.5 10.5h17" /></>;
    case 'globe': return <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.2 2.5 3.2 5.5 3.2 9s-1 6.5-3.2 9c-2.2-2.5-3.2-5.5-3.2-9S9.8 5.5 12 3Z" /></>;
    case 'image': return <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m6.5 16 4-4 3 3 2-2 3 3" /><circle cx="8" cy="9" r="1.2" /></>;
    case 'info': return <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>;
    case 'key': return <><circle cx="7.5" cy="12" r="3.5" /><path d="M11 12h10" /><path d="M17 12v3" /><path d="M20 12v2" /></>;
    case 'language': return <><path d="M4 5h8" /><path d="M8 3v2" /><path d="M5 9c1.5 3 4.5 5 8 6" /><path d="M11 5c-.7 4.2-3.3 7.2-7 9" /><path d="m14 19 4-9 4 9" /><path d="M15.4 16h5.2" /></>;
    case 'location': return <><path d="M12 21s7-5.2 7-11a7 7 0 0 0-14 0c0 5.8 7 11 7 11Z" /><circle cx="12" cy="10" r="2.3" /></>;
    case 'plus': return <path d="M12 5v14M5 12h14" />;
    case 'refresh': return <><path d="M20 11a8 8 0 0 0-14.4-4.8L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.4 4.8L20 16" /><path d="M20 20v-4h-4" /></>;
    case 'save': return <><path d="M5 4h12l2 2v14H5V4Z" /><path d="M8 4v6h8V4" /><path d="M8 20v-6h8v6" /></>;
    case 'search': return <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>;
    case 'settings': return <><circle cx="12" cy="12" r="3" /><path d="M19 12a7.3 7.3 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.8-1L14.4 3h-4.8L9.2 6a7 7 0 0 0-1.8 1L5 6 3 9.5 5 11a7.3 7.3 0 0 0 0 2l-2 1.5L5 18l2.4-1a7 7 0 0 0 1.8 1l.4 3h4.8l.4-3a7 7 0 0 0 1.8-1l2.4 1 2-3.5-2-1.5c.1-.3.1-.7.1-1Z" /></>;
    case 'sparkle': return <><path d="M12 3l1.8 5 5.2 1.8-5.2 1.8L12 17l-1.8-5.4L5 9.8 10.2 8 12 3Z" /><path d="M5 16l.8 2.2L8 19l-2.2.8L5 22l-.8-2.2L2 19l2.2-.8L5 16Z" /></>;
    case 'test': return <><path d="M9 3v5l-4.8 8.4A3 3 0 0 0 6.8 21h10.4a3 3 0 0 0 2.6-4.6L15 8V3" /><path d="M8 3h8" /><path d="M7 15h10" /></>;
    case 'trash': return <><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M6 7l1 14h10l1-14" /><path d="M9 7V4h6v3" /></>;
  }
}
