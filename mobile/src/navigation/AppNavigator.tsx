import React from 'react';
import { Text } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { colors } from '../theme/colors';

// Screens
import { DashboardScreen } from '../screens/DashboardScreen';
import { RepoListScreen } from '../screens/RepoListScreen';
import { RepoScreen } from '../screens/RepoScreen';
import { FileViewerScreen } from '../screens/FileViewerScreen';
import { CommitsScreen } from '../screens/CommitsScreen';
import { IssuesScreen } from '../screens/IssuesScreen';
import { IssueDetailScreen } from '../screens/IssueDetailScreen';
import { PullsScreen } from '../screens/PullsScreen';
import { PullDetailScreen } from '../screens/PullDetailScreen';
import { GateStatusScreen } from '../screens/GateStatusScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { AskAIScreen } from '../screens/AskAIScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

// ─── Param list types ────────────────────────────────────────────────────────

export type RepoStackParamList = {
  RepoList: undefined;
  Repo: { owner: string; repo: string };
  FileViewer: { owner: string; repo: string; ref: string; path: string };
  Commits: { owner: string; repo: string; branch?: string };
  Issues: { owner: string; repo: string };
  IssueDetail: { owner: string; repo: string; number: number };
  Pulls: { owner: string; repo: string };
  PullDetail: { owner: string; repo: string; number: number };
  GateStatus: { owner: string; repo: string };
};

export type MainTabParamList = {
  Dashboard: undefined;
  Repos: undefined;
  Notifications: undefined;
  AskAI: undefined;
  Settings: undefined;
};

// ─── Repo Stack ───────────────────────────────────────────────────────────────

const RepoStack = createNativeStackNavigator<RepoStackParamList>();

function RepoStackNavigator(): React.ReactElement {
  return (
    <RepoStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bgSecondary },
        headerTintColor: colors.text,
        headerTitleStyle: { color: colors.text, fontWeight: '600' },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <RepoStack.Screen
        name="RepoList"
        component={RepoListScreen}
        options={{ title: 'Repositories' }}
      />
      <RepoStack.Screen
        name="Repo"
        component={RepoScreen}
        options={({ route }) => ({
          title: `${route.params.owner}/${route.params.repo}`,
        })}
      />
      <RepoStack.Screen
        name="FileViewer"
        component={FileViewerScreen}
        options={({ route }) => ({
          title: route.params.path.split('/').pop() ?? 'File',
        })}
      />
      <RepoStack.Screen
        name="Commits"
        component={CommitsScreen}
        options={{ title: 'Commits' }}
      />
      <RepoStack.Screen
        name="Issues"
        component={IssuesScreen}
        options={{ title: 'Issues' }}
      />
      <RepoStack.Screen
        name="IssueDetail"
        component={IssueDetailScreen}
        options={({ route }) => ({ title: `Issue #${route.params.number}` })}
      />
      <RepoStack.Screen
        name="Pulls"
        component={PullsScreen}
        options={{ title: 'Pull Requests' }}
      />
      <RepoStack.Screen
        name="PullDetail"
        component={PullDetailScreen}
        options={({ route }) => ({ title: `PR #${route.params.number}` })}
      />
      <RepoStack.Screen
        name="GateStatus"
        component={GateStatusScreen}
        options={{ title: 'Gate Runs' }}
      />
    </RepoStack.Navigator>
  );
}

// ─── Tab icons ───────────────────────────────────────────────────────────────

function TabIcon({
  label,
  focused,
}: {
  label: string;
  focused: boolean;
}): React.ReactElement {
  const icons: Record<string, string> = {
    Dashboard: '⌂',
    Repos: '⑂',
    Notifications: '🔔',
    AskAI: '✦',
    Settings: '⚙',
  };
  const icon = icons[label] ?? label[0];
  return (
    <Text style={{ fontSize: 18, color: focused ? colors.accentBlue : colors.textMuted }}>
      {icon}
    </Text>
  );
}

// ─── Bottom Tabs ─────────────────────────────────────────────────────────────

const Tab = createBottomTabNavigator<MainTabParamList>();

export function AppNavigator(): React.ReactElement {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bgSecondary,
          borderTopColor: colors.border,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: colors.accentBlue,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
        tabBarIcon: ({ focused }) => (
          <TabIcon label={route.name} focused={focused} />
        ),
      })}
    >
      <Tab.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{ tabBarLabel: 'Home' }}
      />
      <Tab.Screen
        name="Repos"
        component={RepoStackNavigator}
        options={{ tabBarLabel: 'Repos' }}
      />
      <Tab.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{ tabBarLabel: 'Inbox' }}
      />
      <Tab.Screen
        name="AskAI"
        component={AskAIScreen}
        options={{
          tabBarLabel: 'Ask AI',
          tabBarActiveTintColor: colors.accentPurple,
          tabBarIcon: ({ focused }) => (
            <Text style={{ fontSize: 18, color: focused ? colors.accentPurple : colors.textMuted }}>
              ✦
            </Text>
          ),
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarLabel: 'Settings' }}
      />
    </Tab.Navigator>
  );
}
