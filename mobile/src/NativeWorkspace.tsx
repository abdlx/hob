import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { DarkTheme, DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import type { Connection } from './connection';
import type { RootStackParams } from './workspace-types';
import { WorkspaceProvider } from './WorkspaceContext';
import { usePalette } from './ui';
import { WebSettings } from './WebSettings';
import { ChatScreen } from './ChatScreen';
import { BotsScreen } from './BotsScreen';
import { openPage } from './navigation';
import {
  ActivityScreen,
  AppearanceScreen,
  BrowserScreen,
  ConversationsScreen,
  FileScreen,
  GoalScreen,
  GoalsScreen,
  IdentityScreen,
  LibraryScreen,
  MemoryEntryScreen,
  MemoryScreen,
  ModelScreen,
  ReviewScreen,
  SettingsScreen,
  SkillScreen,
  SkillsScreen,
  ToolsScreen,
  WorkshopScreen,
} from './WorkspaceScreens';

const Stack = createNativeStackNavigator<RootStackParams>();
type BotRoute = Exclude<keyof RootStackParams, 'Connection' | 'Bots'>;

function scoped<N extends BotRoute>(Component: React.ComponentType<NativeStackScreenProps<RootStackParams, N>>) {
  return function ScopedScreen(props: NativeStackScreenProps<RootStackParams, N>) {
    return <Component key={(props.route.params as { profile: string }).profile} {...props} />;
  };
}

const Chat = scoped(ChatScreen);
const Conversations = scoped(ConversationsScreen);
const Activity = scoped(ActivityScreen);
const Goals = scoped(GoalsScreen);
const Goal = scoped(GoalScreen);
const Library = scoped(LibraryScreen);
const File = scoped(FileScreen);
const Skills = scoped(SkillsScreen);
const Skill = scoped(SkillScreen);
const Memory = scoped(MemoryScreen);
const MemoryEntry = scoped(MemoryEntryScreen);
const Workshop = scoped(WorkshopScreen);
const Review = scoped(ReviewScreen);
const Identity = scoped(IdentityScreen);
const Tools = scoped(ToolsScreen);
const Browser = scoped(BrowserScreen);
const Settings = scoped(SettingsScreen);
const Appearance = scoped(AppearanceScreen);
const Model = scoped(ModelScreen);

export interface ConversationTarget {
  profile: string;
  sessionKey: string;
  requestId: string;
}

function Navigator({ connectionScreen, target }: { connectionScreen: React.ComponentType<{ navigation: { goBack: () => void } }>; target: ConversationTarget | null }) {
  const p = usePalette();
  const [navigation] = useState(() => createNavigationContainerRef<RootStackParams>());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ready || !target) return;
    navigation.dispatch(openPage('Chat', target.profile, { id: target.sessionKey }));
  }, [ready, target, navigation]);

  const dark = p.canvas === '#060605';
  const theme = dark ? DarkTheme : DefaultTheme;

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <NavigationContainer
        ref={navigation}
        theme={{
          ...theme,
          colors: {
            ...theme.colors,
            background: p.canvas,
            card: p.canvas,
            text: p.ink,
            border: p.hair,
            primary: p.accent,
          },
        }}
        onReady={() => setReady(true)}
      >
        <Stack.Navigator
          initialRouteName="Bots"
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: p.canvas },
            animation: 'default',
          }}
        >
          <Stack.Screen options={{ animation: 'none' }} name="Bots" component={BotsScreen} />
          <Stack.Screen options={{ animation: 'none' }} name="Chat" component={Chat} initialParams={{ profile: 'default' }} />
          <Stack.Screen options={{ animation: 'none' }} name="Conversations" component={Conversations} />
          <Stack.Screen options={{ animation: 'none' }} name="Activity" component={Activity} />
          <Stack.Screen options={{ animation: 'none' }} name="Workshop" component={Workshop} />
          <Stack.Screen options={{ animation: 'none' }} name="Goals" component={Goals} />
          <Stack.Screen name="Goal" component={Goal} />
          <Stack.Screen options={{ animation: 'none' }} name="Library" component={Library} />
          <Stack.Screen name="File" component={File} />
          <Stack.Screen name="Skills" component={Skills} />
          <Stack.Screen name="Skill" component={Skill} />
          <Stack.Screen name="Memory" component={Memory} />
          <Stack.Screen name="MemoryEntry" component={MemoryEntry} />
          <Stack.Screen name="Review" component={Review} />
          <Stack.Screen name="Identity" component={Identity} />
          <Stack.Screen name="Tools" component={Tools} />
          <Stack.Screen name="Browser" component={Browser} />
          <Stack.Screen options={{ animation: 'none' }} name="Settings" component={Settings} />
          <Stack.Screen name="WebSettings" component={WebSettings} />
          <Stack.Screen name="Appearance" component={Appearance} />
          <Stack.Screen name="Model" component={Model} />
          <Stack.Screen name="Connection" component={connectionScreen as React.ComponentType<NativeStackScreenProps<RootStackParams, 'Connection'>>} />
        </Stack.Navigator>
      </NavigationContainer>
    </View>
  );
}

export function NativeWorkspace({
  connection,
  connectionScreen,
  target,
}: {
  connection: Connection;
  connectionScreen: React.ComponentType<{ navigation: { goBack: () => void } }>;
  target: ConversationTarget | null;
}) {
  return (
    <WorkspaceProvider connection={connection}>
      <Navigator connectionScreen={connectionScreen} target={target} />
    </WorkspaceProvider>
  );
}
