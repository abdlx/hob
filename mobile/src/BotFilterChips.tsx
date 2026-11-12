import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useWorkspace } from './WorkspaceContext';
import { AppText as Text, BotAvatar, usePalette } from './ui';

export interface BotFilterChipsProps {
  selectedBotId: string | null;
  onSelectBot: (botId: string | null) => void;
  includeAll?: boolean;
}

export function BotFilterChips({
  selectedBotId,
  onSelectBot,
  includeAll = true,
}: BotFilterChipsProps) {
  const p = usePalette();
  const { bots, connection } = useWorkspace();

  if (!bots || bots.length === 0) return null;

  return (
    <View style={{ marginBottom: 12 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          gap: 8,
          alignItems: 'center',
          flexDirection: 'row',
        }}
      >
        {includeAll && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Filter by all bots"
            accessibilityState={{ selected: selectedBotId === null }}
            onPress={() => {
              void Haptics.selectionAsync().catch(() => undefined);
              onSelectBot(null);
            }}
            style={({ pressed }) => ({
              minHeight: 34,
              paddingHorizontal: 14,
              paddingVertical: 6,
              borderRadius: 17,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selectedBotId === null ? p.selected : p.panel,
              borderWidth: 1,
              borderColor: selectedBotId === null ? p.accent : p.hair,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: selectedBotId === null ? '600' : '500',
                color: selectedBotId === null ? p.accent : p.ink,
              }}
            >
              All bots
            </Text>
          </Pressable>
        )}

        {bots.map(bot => {
          const isSelected = selectedBotId === bot.id;
          return (
            <Pressable
              key={bot.id}
              accessibilityRole="button"
              accessibilityLabel={`Filter by ${bot.name}`}
              accessibilityState={{ selected: isSelected }}
              onPress={() => {
                void Haptics.selectionAsync().catch(() => undefined);
                // Toggle off to all if clicked again, or switch to this bot
                onSelectBot(isSelected && includeAll ? null : bot.id);
              }}
              style={({ pressed }) => ({
                minHeight: 34,
                paddingLeft: 6,
                paddingRight: 12,
                paddingVertical: 5,
                borderRadius: 17,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 7,
                backgroundColor: isSelected ? p.selected : p.panel,
                borderWidth: 1,
                borderColor: isSelected ? p.accent : p.hair,
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <BotAvatar
                name={bot.name}
                id={bot.id}
                size={22}
                uri={bot.avatarUrl}
                token={connection.token}
              />
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 13,
                  fontWeight: isSelected ? '600' : '500',
                  color: isSelected ? p.accent : p.ink,
                  maxWidth: 120,
                }}
              >
                {bot.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

