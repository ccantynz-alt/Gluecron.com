import { useState, useEffect, useCallback } from 'react';
import { api, type User } from '../api/client';
import {
  saveToken,
  loadToken,
  clearAll,
  saveUser,
  loadUser,
  saveHost,
  loadHost,
} from '../store/auth';
import { setBaseUrl } from '../api/client';

export interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    loading: true,
    error: null,
  });

  // Hydrate from secure storage on mount
  useEffect(() => {
    (async () => {
      try {
        const [token, user, host] = await Promise.all([
          loadToken(),
          loadUser(),
          loadHost(),
        ]);
        if (host) {
          setBaseUrl(host);
        }
        if (token && user) {
          setState({ user, token, loading: false, error: null });
        } else {
          setState({ user: null, token: null, loading: false, error: null });
        }
      } catch {
        setState({ user: null, token: null, loading: false, error: null });
      }
    })();
  }, []);

  const login = useCallback(async (usernameOrToken: string, passwordOrEmpty?: string, host?: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      if (host) {
        setBaseUrl(host);
        await saveHost(host);
      }

      let token: string;
      let user: User;

      // PAT token login: if passwordOrEmpty is empty, treat usernameOrToken as raw token
      if (!passwordOrEmpty) {
        token = usernameOrToken;
        api.setToken(token);
        user = await api.getMe();
      } else {
        // Username + password login
        const res = await api.login(usernameOrToken, passwordOrEmpty);
        token = res.token;
        api.setToken(token);
        user = await api.getMe();
      }

      await Promise.all([saveToken(token), saveUser(user)]);
      setState({ user, token, loading: false, error: null });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      setState((s) => ({ ...s, loading: false, error: msg }));
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    await clearAll();
    setState({ user: null, token: null, loading: false, error: null });
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return {
    ...state,
    isAuthenticated: !!state.token && !!state.user,
    login,
    logout,
    clearError,
  };
}
