import { create } from 'zustand';

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
}

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  token: string | null;
  setAuth: (user: AuthUser, token: string) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  user: null,
  token: null,
  setAuth: (user: AuthUser, token: string) =>
    set({ isAuthenticated: true, user, token }),
  clearAuth: () =>
    set({ isAuthenticated: false, user: null, token: null }),
}));
