import { createContext } from 'react';
import { type User } from '../api/client';

export interface AuthContextValue {
  user: User | null;
  token: string | null;
  login: (tokenOrUsername: string, password?: string, host?: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  login: async () => {},
  logout: async () => {},
});
