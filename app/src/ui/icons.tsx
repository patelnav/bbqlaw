// Stand-ins for the SF Symbols the 1.0 app used (expo-symbols is not in the
// frozen native package list). 24 x 24 drawings.
import Svg, { Path, Rect } from 'react-native-svg';

const STROKES = {
  gearshape: [
    'M10.3 3h3.4l.5 2.4 1.5.9 2.3-.8 1.7 3-1.8 1.6v1.8l1.8 1.6-1.7 3-2.3-.8-1.5.9-.5 2.4h-3.4l-.5-2.4-1.5-.9-2.3.8-1.7-3 1.8-1.6v-1.8L4.3 8.500l1.7-3 2.3.8 1.5-.9z',
    'M12 9.200a2.800 2.800 0 1 0 0 5.600a2.800 2.800 0 1 0 0-5.600z',
  ],
  thermometer: ['M7 14V5.500a2.500 2.500 0 0 1 5 0V14a4.500 4.500 0 1 1-5 0z', 'M9.500 10v7', 'M15 6h5', 'M15 10h4', 'M15 14h3'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  bellSlash: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4', 'M3 3l18 18'],
  pencil: ['M4 20l1-4L16 5l3 3L8 19z', 'M14 7l3 3'],
  chevronRight: ['M9 5l7 7-7 7'],
  xmark: ['M6 6l12 12', 'M18 6L6 18'],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M10.500 4a6.500 6.500 0 1 0 0 13a6.500 6.500 0 1 0 0-13z', 'M15.500 15.500L21 21'],
  speaker: ['M4 9v6h4l5 4V5L8 9z', 'M16.500 8.500a5 5 0 0 1 0 7', 'M19 6a9 9 0 0 1 0 12'],
  speakerSlash: ['M4 9v6h4l5 4V5L8 9z', 'M3 3l18 18'],
  trash: ['M5 7h14', 'M10 7V4h4v3', 'M7 7l1 13h8l1-13', 'M10 11v5', 'M14 11v5'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  link: ['M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.600-5.600l-1.4 1.4', 'M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.600 5.600l1.4-1.4'],
} as const;

export type IconName = keyof typeof STROKES | 'sealCheck' | 'warning' | 'plug' | 'battery' | 'batteryBolt';

export function Icon({ name, size = 20, color, weight = 2 }: {
  name: IconName; size?: number; color: string; weight?: number;
}) {
  const box = { width: size, height: size, viewBox: '0 0 24 24' };
  if (name === 'sealCheck') {
    return (
      <Svg {...box}>
        <Path fill={color} d="M12 1.500l2.600 2 3.200-.2.900 3.1 2.700 1.800-1.100 3 1.100 3-2.700 1.800-.9 3.100-3.200-.2-2.600 2-2.600-2-3.200.2-.9-3.1-2.700-1.800 1.100-3-1.100-3 2.700-1.800.9-3.1 3.200.2z" />
        <Path stroke="#FFFFFF" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" fill="none" d="M7.800 12.200l2.800 2.800 5.600-5.600" />
      </Svg>
    );
  }
  if (name === 'warning') {
    return (
      <Svg {...box}>
        <Path fill={color} d="M12 2.500L23 21H1z" />
        <Path stroke="#FFFFFF" strokeWidth={2.2} strokeLinecap="round" d="M12 9v5.500M12 17.800v.1" />
      </Svg>
    );
  }
  if (name === 'plug') {
    return (
      <Svg {...box}>
        <Path fill={color} d="M8 2a1.200 1.200 0 0 1 1.200 1.200V7h5.600V3.200a1.200 1.200 0 0 1 2.400 0V7H19v2h-1v3a6 6 0 0 1-4.800 5.900V22h-2.400v-4.100A6 6 0 0 1 6 12V9H5V7h1.800V3.200A1.200 1.200 0 0 1 8 2z" />
      </Svg>
    );
  }
  if (name === 'battery' || name === 'batteryBolt') {
    return (
      <Svg width={size * 1.3} height={size} viewBox="0 0 31 24">
        <Rect x={1} y={6} width={25} height={12} rx={3.500} stroke={color} strokeWidth={1.600} fill="none" opacity={0.6} />
        <Rect x={3} y={8} width={21} height={8} rx={2} fill={color} />
        <Path d="M28 10v4c1.300-.3 2-1 2-2s-.7-1.700-2-2z" fill={color} />
        {name === 'batteryBolt' ? <Path d="M15.500 4L9 13h4l-1.500 7L18 11h-4z" fill={color} stroke="#FFFFFF" strokeWidth={1} /> : null}
      </Svg>
    );
  }
  return (
    <Svg {...box}>
      {STROKES[name].map((d) => (
        <Path key={d} d={d} stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ))}
    </Svg>
  );
}

