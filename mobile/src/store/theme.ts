import { colors } from '../theme/colors';

export type ThemeMode = 'dark' | 'light';

// Currently only dark mode is supported — matches Gluecron's design.
// Light mode scaffolding is here for future expansion.
let _mode: ThemeMode = 'dark';

export function getThemeMode(): ThemeMode {
  return _mode;
}

export function setThemeMode(mode: ThemeMode): void {
  _mode = mode;
}

export function getColors() {
  return colors;
}
