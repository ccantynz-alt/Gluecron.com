import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { validateToken, persistToken, clearToken } from '../api/auth';
import { PAT_STORE_KEY } from '../api/client';

export interface UseAuthReturn {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: ReturnType<typeof useAuthStore.getState>['user'];
  login: (host: string, token: string) => Promise<void>;
  logout: () => Promise<void>;
  error: string | null;
}

/**
 * Primary auth hook. Checks SecureStore on mount and exposes
 * login / logout helpers that update both SecureStore and the
 * in-memory Zustand store.
 */
export function useAuth(): UseAuthReturn {
  const { isAuthenticated, user, setAuth, clearAuth } = useAuthStore();
  const { setHost } = useSettingsStore();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // On mount, check if there is a saved token and auto-login.
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const savedToken = await SecureStore.getItemAsync(PAT_STORE_KEY);
        const savedHost = await SecureStore.getItemAsync('gluecron_host');

        if (savedToken && savedHost) {
          setHost(savedHost);
          const authUser = await validateToken(savedHost, savedToken);
          if (!cancelled) {
            setAuth(authUser, savedToken);
          }
        }
      } catch {
        // Token invalid or network error — stay logged out silently
        await SecureStore.deleteItemAsync(PAT_STORE_KEY);
        await SecureStore.deleteItemAsync('gluecron_host');
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    restoreSession();
    return () => {
      cancelled = true;
    };
  }, [setAuth, setHost]);

  const login = useCallback(
    async (host: string, token: string) => {
      setError(null);
      setIsLoading(true);
      try {
        const normalizedHost = host.replace(/\/$/, '');
        const authUser = await validateToken(normalizedHost, token);
        await persistToken(token);
        await SecureStore.setItemAsync('gluecron_host', normalizedHost);
        setHost(normalizedHost);
        setAuth(authUser, token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Login failed';
        setError(msg);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [setAuth, setHost],
  );

  const logout = useCallback(async () => {
    setIsLoading(true);
    try {
      await clearToken();
      await SecureStore.deleteItemAsync('gluecron_host');
    } finally {
      clearAuth();
      setIsLoading(false);
    }
  }, [clearAuth]);

  return { isAuthenticated, isLoading, user, login, logout, error };
}
