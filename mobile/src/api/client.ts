import * as SecureStore from 'expo-secure-store';
import { useSettingsStore } from '../store/settingsStore';

export const PAT_STORE_KEY = 'gluecron_pat';

/** Retrieves the saved PAT from SecureStore. Returns null if none saved. */
export async function getSavedToken(): Promise<string | null> {
  return SecureStore.getItemAsync(PAT_STORE_KEY);
}

/** Saves a PAT to SecureStore. */
export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(PAT_STORE_KEY, token);
}

/** Removes the saved PAT from SecureStore. */
export async function removeToken(): Promise<void> {
  await SecureStore.deleteItemAsync(PAT_STORE_KEY);
}

/** Build the full URL for a given API path. */
function buildUrl(path: string): string {
  const host = useSettingsStore.getState().host;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${host}${normalizedPath}`;
}

/** Build common headers, injecting the Bearer token if one is saved. */
async function buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const token = await getSavedToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Performs a GET (or custom method) request and parses the JSON response. */
export async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await buildHeaders(init?.headers as Record<string, string> | undefined);
  const response = await fetch(buildUrl(path), {
    ...init,
    headers,
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as Record<string, unknown>).error)
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message, body);
  }

  return response.json() as Promise<T>;
}

/** Performs a POST request with a JSON body. */
export async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const headers = await buildHeaders();
  const response = await fetch(buildUrl(path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = await response.text();
    }
    const message =
      typeof errorBody === 'object' &&
      errorBody !== null &&
      'error' in errorBody
        ? String((errorBody as Record<string, unknown>).error)
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message, errorBody);
  }

  return response.json() as Promise<T>;
}

/** Performs a PATCH request with a JSON body. */
export async function patchJSON<T>(path: string, body: unknown): Promise<T> {
  const headers = await buildHeaders();
  const response = await fetch(buildUrl(path), {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = await response.text();
    }
    const message =
      typeof errorBody === 'object' &&
      errorBody !== null &&
      'error' in errorBody
        ? String((errorBody as Record<string, unknown>).error)
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message, errorBody);
  }

  return response.json() as Promise<T>;
}

/** Performs a DELETE request. */
export async function deleteRequest(path: string): Promise<void> {
  const headers = await buildHeaders();
  const response = await fetch(buildUrl(path), {
    method: 'DELETE',
    headers,
  });

  if (!response.ok) {
    throw new ApiError(response.status, `HTTP ${response.status}`);
  }
}

/** Executes a GraphQL query against /api/graphql. */
export async function graphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const result = await postJSON<{ data?: T; errors?: Array<{ message: string }> }>(
    '/api/graphql',
    { query, variables },
  );

  if (result.errors && result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join('; '));
  }

  if (result.data === undefined) {
    throw new Error('GraphQL response missing data field');
  }

  return result.data;
}
