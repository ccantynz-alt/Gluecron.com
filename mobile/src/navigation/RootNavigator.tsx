import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '../theme/colors';
import { AuthScreen } from '../screens/AuthScreen';
import { MainTabNavigator } from './MainTabNavigator';
import { useAuth } from '../hooks/useAuth';
import { AuthContext } from './AuthContext';

// Re-export AuthContext so callers can do: import { AuthContext } from '../navigation/RootNavigator'
export { AuthContext };
export type { AuthContextValue } from './AuthContext';

// ─── Root param list ──────────────────────────────────────────────────────────

type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// ─── Navigator ────────────────────────────────────────────────────────────────

export function RootNavigator() {
  const auth = useAuth();

  if (auth.loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        user: auth.user,
        token: auth.token,
        login: auth.login,
        logout: auth.logout,
      }}
    >
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
