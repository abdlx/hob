import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Icon } from './icons';
import { AppText as Text, BotAvatar, usePalette } from './ui';
import type { Bot } from './workspace-types';

export function ChatHeader({
  bot,
  onOpenDrawer,
  onOpenRightPanel,
  onNewChat,
  disabledNewChat = false,
  token,
}: {
  bot?: Bot;
  onOpenDrawer: () => void;
  onOpenRightPanel: () => void;
  onNewChat: () => void;
  disabledNewChat?: boolean;
  token?: string;
}) {
  const p = usePalette(), insets = useSafeAreaInsets();
  const name = bot?.name || 'Main';

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: insets.top + 160,
        paddingTop: insets.top + 20,
        paddingHorizontal: Math.max(insets.left, insets.right, 15),
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        zIndex: 20,
      }}
    >
      {/* Left button: Menu with accent indicator */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open navigation"
        onPress={() => {
          void Haptics.selectionAsync().catch(() => undefined);
          onOpenDrawer();
        }}
        style={({ pressed }) => ({
          width: 46,
          height: 46,
          borderRadius: 23,
          backgroundColor: p.control,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.75 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        })}
      >
        <Icon name="Menu" color={p.ink} size={22} strokeWidth={1.5} />
        <View
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: p.accent,
          }}
        />
      </Pressable>

      {/* Center: 88px Avatar + name pill underneath - dead center alignment */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          top: insets.top + 20,
          left: 0,
          right: 0,
          alignItems: 'center',
          zIndex: 2,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open details for ${name}`}
          onPress={() => {
            void Haptics.selectionAsync().catch(() => undefined);
            onOpenRightPanel();
          }}
          style={({ pressed }) => ({
            alignItems: 'center',
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <View style={{ zIndex: 2 }}>
            <BotAvatar name={name} id={bot?.id || 'default'} size={88} uri={bot?.avatarUrl} token={token} />
          </View>
          <View
            style={{
              zIndex: 1,
              marginTop: -8,
              paddingTop: 10,
              paddingBottom: 4,
              paddingHorizontal: 12,
              minHeight: 32,
              maxWidth: 210,
              borderRadius: 24,
              backgroundColor: p.control,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <Text numberOfLines={1} style={{ color: p.ink, fontSize: 15, fontWeight: '600', lineHeight: 20 }}>
              {name}
            </Text>
            {bot?.tags?.slice(0, 2).map(tag => (
              <Text key={tag} numberOfLines={1} style={{ fontSize: 10, fontWeight: '400', color: p.muted }}>
                {tag}
              </Text>
            ))}
          </View>
        </Pressable>
      </View>

      {/* Right button: New conversation */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New conversation"
        disabled={disabledNewChat}
        onPress={() => {
          void Haptics.selectionAsync().catch(() => undefined);
          onNewChat();
        }}
        style={({ pressed }) => ({
          width: 46,
          height: 46,
          borderRadius: 23,
          backgroundColor: p.control,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabledNewChat ? 0.4 : pressed ? 0.75 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        })}
      >
        <Icon name="Add" color={p.ink} size={24} strokeWidth={1.7} />
      </Pressable>
    </View>
  );
}

