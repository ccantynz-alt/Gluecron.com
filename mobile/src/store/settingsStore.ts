import { create } from 'zustand';

interface SettingsState {
  host: string;
  setHost: (host: string) => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  host: process.env.EXPO_PUBLIC_DEFAULT_HOST ?? 'https://gluecron.com',
  setHost: (host: string) =>
    set({ host: host.replace(/\/$/, '') }),
  notificationsEnabled: true,
  setNotificationsEnabled: (enabled: boolean) =>
    set({ notificationsEnabled: enabled }),
}));
