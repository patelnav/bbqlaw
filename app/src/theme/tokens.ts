// BBQlaw design tokens (DESIGN.md / DesignSystem.swift). Flat surfaces, hairline
// borders, no drop shadows. The only warm note is the ember accent and temp ramp.
import { useColorScheme, type TextStyle } from 'react-native';

const constant = {
  emberFlat: '#E3611F',
  tempCold: '#4A7DB5',
  tempCool: '#7FA8C9',
  tempWarm: '#E0A93C',
  tempHot: '#E3611F',
  tempFire: '#C2410C',
  statusIdle: '#4A7DB5',
  warning: '#E0A93C',
  danger: '#DC2626',
  dangerTint: 'rgba(220,38,38,0.12)',
  white: '#FFFFFF',
} as const;

export const lightColors = {
  ...constant,
  ember: '#E3611F',
  bg: '#F3F4F6',
  bgSunken: '#E8EAEE',
  surface: '#FFFFFF',
  surface2: '#F5F6F8',
  fg1: '#191B20',
  fg2: '#5C616B',
  fg3: '#8D929B',
  line: '#E2E4E9',
  lineStrong: '#C8CCD3',
  emberTint: 'rgba(227,97,31,0.10)',
  slateTint: 'rgba(74,125,181,0.12)',
};

export type Colors = typeof lightColors;

export const darkColors: Colors = {
  ...constant,
  ember: '#FF6B2C',
  bg: '#16110E',
  bgSunken: '#0E0B09',
  surface: '#211A16',
  surface2: '#2A211C',
  fg1: '#F6EFE9',
  fg2: '#B39C8D',
  fg3: '#7D6B5E',
  line: 'rgba(255,255,255,0.09)',
  lineStrong: 'rgba(255,255,255,0.16)',
  emberTint: 'rgba(255,107,44,0.14)',
  slateTint: 'rgba(127,168,201,0.16)',
};

export const useColors = (): Colors => (useColorScheme() === 'dark' ? darkColors : lightColors);

export const radius = { sm: 9, md: 13, lg: 16, xl: 22 } as const;

type Weight = NonNullable<TextStyle['fontWeight']>;

/** Apple's system faces, as in the 1.0 app. */
export const font = {
  /** Hero numerals and big display: SF Pro Rounded. */
  display: (size: number, weight: Weight = '800'): TextStyle => ({
    fontFamily: 'ui-rounded', fontSize: size, fontWeight: weight,
  }),
  ui: (size: number, weight: Weight = '400'): TextStyle => ({ fontSize: size, fontWeight: weight }),
  /** Technical readouts: SF Mono. */
  mono: (size: number, weight: Weight = '500'): TextStyle => ({
    fontFamily: 'ui-monospace', fontSize: size, fontWeight: weight,
  }),
};
