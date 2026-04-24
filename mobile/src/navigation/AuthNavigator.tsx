import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LoginScreen } from '../screens/LoginScreen';
import { colors } from '../theme/colors';

export type AuthStackParamList = {
  Login: undefined;
};

const Stack = createNativeStackNavigator<AuthStackParamList>();

export function AuthNavigator(): React.ReactElement {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="Login" component={LoginScreen} />
    </Stack.Navigator>
  );
}
