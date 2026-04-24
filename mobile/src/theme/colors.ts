export const colors = {
  bg: '#0d1117',
  bgSecondary: '#161b22',
  bgTertiary: '#21262d',
  border: '#30363d',
  text: '#e6edf3',
  textMuted: '#8b949e',
  textLink: '#58a6ff',
  accent: '#238636',       // green — gates passing
  accentRed: '#da3633',
  accentYellow: '#d29922',
  accentPurple: '#bc8cff', // AI features
  accentBlue: '#58a6ff',
} as const;

export type ColorKey = keyof typeof colors;
