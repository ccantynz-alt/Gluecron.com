import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { fontSizes } from '../theme/typography';

import { DashboardScreen } from '../screens/DashboardScreen';
import { RepoListScreen } from '../screens/RepoListScreen';
import { RepoDetailScreen } from '../screens/RepoDetailScreen';
import { FileViewerScreen } from '../screens/FileViewerScreen';
import { IssueListScreen } from '../screens/IssueListScreen';
import { IssueDetailScreen } from '../screens/IssueDetailScreen';
import { PullListScreen } from '../screens/PullListScreen';
import { PullDetailScreen } from '../screens/PullDetailScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

// ─── Stack param types ───────────────────────────────────────────────────────

export type MainStackParamList = {
  Dashboard: undefined;
  RepoList: undefined;
  RepoDetail: { owner: string; repo: string };
  FileViewer: { owner: string; repo: string; path: string; ref: string };
  IssueList: { owner: string; repo: string };
  IssueDetail: { owner: string; repo: string; number: number };
  PullList: { owner: string; repo: string };
  PullDetail: { owner: string; repo: string; number: number };
};

const Stack = createNativeStackNavigator<MainStackParamList>();
const Tab = createBottomTabNavigator();

// ─── Stack navigators (one per tab root) ────────────────────────────────────

function DashboardStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="Dashboard" component={DashboardScreen} options={{ title: 'Dashboard' }} />
      <Stack.Screen name="RepoDetail" component={RepoDetailScreen} options={({ route }) => ({ title: route.params.repo })} />
      <Stack.Screen name="FileViewer" component={FileViewerScreen} options={({ route }) => ({ title: route.params.path.split('/').pop() ?? 'File' })} />
      <Stack.Screen name="IssueList" component={IssueListScreen} options={{ title: 'Issues' }} />
      <Stack.Screen name="IssueDetail" component={IssueDetailScreen} options={({ route }) => ({ title: `#${route.params.number}` })} />
      <Stack.Screen name="PullList" component={PullListScreen} options={{ title: 'Pull Requests' }} />
      <Stack.Screen name="PullDetail" component={PullDetailScreen} options={({ route }) => ({ title: `PR #${route.params.number}` })} />
      {/* Dummy screens required by type — never actually navigated to from this stack */}
      <Stack.Screen name="RepoList" component={RepoListScreen} options={{ title: 'Repositories' }} />
    </Stack.Navigator>
  );
}

function RepoStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="RepoList" component={RepoListScreen} options={{ title: 'Repositories' }} />
      <Stack.Screen name="RepoDetail" component={RepoDetailScreen} options={({ route }) => ({ title: route.params.repo })} />
      <Stack.Screen name="FileViewer" component={FileViewerScreen} options={({ route }) => ({ title: route.params.path.split('/').pop() ?? 'File' })} />
      <Stack.Screen name="IssueList" component={IssueListScreen} options={{ title: 'Issues' }} />
      <Stack.Screen name="IssueDetail" component={IssueDetailScreen} options={({ route }) => ({ title: `#${route.params.number}` })} />
      <Stack.Screen name="PullList" component={PullListScreen} options={{ title: 'Pull Requests' }} />
      <Stack.Screen name="PullDetail" component={PullDetailScreen} options={({ route }) => ({ title: `PR #${route.params.number}` })} />
      {/* Dummy — needed to satisfy shared type */}
      <Stack.Screen name="Dashboard" component={DashboardScreen} options={{ title: 'Dashboard' }} />
    </Stack.Navigator>
  );
}

// ─── Tab navigator ───────────────────────────────────────────────────────────

export function MainTabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bgSecondary,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 60,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: {
          fontSize: fontSizes.xs,
          fontWeight: '500',
        },
      }}
    >
      <Tab.Screen
        name="DashboardTab"
        component={DashboardStack}
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color }) => <TabIcon icon="⌂" color={color} />,
        }}
      />
      <Tab.Screen
        name="ReposTab"
        component={RepoStack}
        options={{
          title: 'Repos',
          tabBarIcon: ({ color }) => <TabIcon icon="⌥" color={color} />,
        }}
      />
      <Tab.Screen
        name="NotificationsTab"
        component={NotificationsScreen}
        options={{
          title: 'Notifications',
          tabBarIcon: ({ color }) => <TabIcon icon="◉" color={color} />,
        }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsScreen}
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <TabIcon icon="⚙" color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function TabIcon({ icon, color }: { icon: string; color: string }) {
  return (
    <Text style={{ fontSize: 18, color, lineHeight: 22 }}>{icon}</Text>
  );
}

const stackScreenOptions = {
  headerStyle: { backgroundColor: colors.bgSecondary },
  headerTintColor: colors.text,
  headerTitleStyle: { color: colors.text, fontWeight: '600' as const },
  headerBackTitleVisible: false,
  contentStyle: { backgroundColor: colors.bg },
};
