import { fetchJSON, saveToken, removeToken, PAT_STORE_KEY } from './client';
import * as SecureStore from 'expo-secure-store';
import { useSettingsStore } from '../store/settingsStore';
import type { AuthUser } from '../store/authStore';

export interface MeResponse {
  id: number;
  username: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
}

/**
 * Validates a PAT token against the given host by calling GET /api/users/me.
 * The host is temporarily set in the settings store before the call.
 * Returns the user profile on success; throws ApiError on failure.
 */
export async function validateToken(host: string, token: string): Promise<AuthUser> {
  // Temporarily point the store at the target host so client.ts builds the
  // correct URL. The final host is persisted by the caller (useAuth hook).
  useSettingsStore.getState().setHost(host);

  // Provide the token inline since it is not yet saved to SecureStore.
  const response = await fetch(`${host.replace(/\/$/, '')}/api/users/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body.error === 'string') msg = body.error;
    } catch {
      // ignore parse failures
    }
    throw new Error(msg);
  }

  const data = (await response.json()) as MeResponse;
  return {
    id: data.id,
    username: data.username,
    email: data.email,
    avatarUrl: data.avatarUrl ?? null,
    bio: data.bio ?? null,
    createdAt: data.createdAt,
  };
}

/** Persists the token to SecureStore. */
export async function persistToken(token: string): Promise<void> {
  await saveToken(token);
}

/** Removes the saved token from SecureStore. */
export async function clearToken(): Promise<void> {
  await removeToken();
}

/** Retrieves the current user profile from the API. */
export async function fetchMe(): Promise<AuthUser> {
  return fetchJSON<AuthUser>('/api/users/me');
}
