import React, { createContext, useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '../theme/colors';
import { AuthScreen } from '../screens/AuthScreen';
import { MainTabNavigator } from './MainTabNavigator';
import { useAuth } from '../hooks/useAuth';
import { type User } from '../api/client';

// ─── Auth context — shared across the whole app ───────────────────────────────

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

// ─── Root param list ──────────────────────────────────────────────────────────

type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// ─── Navigator ────────────────────────────────────────────────────────────────

export function RootNavigator() {
  const auth = useAuth();

  const contextValue: AuthContextValue = {
    user: auth.user,
    token: auth.token,
    login: auth.login,
    logout: auth.logout,
  };

  if (auth.loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <AuthContext.Provider value={contextValue}>
      <NavigationContainer
        theme={{
          dark: true,
          colors: {
            primary: colors.accent,
            background: colors.bg,
            card: colors.bgSecondary,
            text: colors.text,
            border: colors.border,
            notification: colors.accent,
          },
        }}
      >
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          {auth.isAuthenticated ? (
            <Stack.Screen name="Main" component={MainTabNavigator} />
          ) : (
            <Stack.Screen name="Auth" component={AuthScreen} />
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </AuthContext.Provider>
  );
}
