import * as SecureStore from 'expo-secure-store';
import { api, type User } from '../api/client';

const TOKEN_KEY = 'gluecron_token';
const USER_KEY = 'gluecron_user';
const HOST_KEY = 'gluecron_host';

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  api.setToken(token);
}

export async function loadToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (token) {
    api.setToken(token);
  }
  return token;
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  api.clearToken();
}

export async function saveUser(user: User): Promise<void> {
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function loadUser(): Promise<User | null> {
  const raw = await SecureStore.getItemAsync(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export async function clearUser(): Promise<void> {
  await SecureStore.deleteItemAsync(USER_KEY);
}

export async function saveHost(host: string): Promise<void> {
  await SecureStore.setItemAsync(HOST_KEY, host);
}

export async function loadHost(): Promise<string | null> {
  return SecureStore.getItemAsync(HOST_KEY);
}

export async function clearAll(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(USER_KEY),
  ]);
  api.clearToken();
}
