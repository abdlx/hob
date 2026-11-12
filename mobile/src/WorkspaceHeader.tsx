import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Icon } from './icons';
import { AppText as Text, usePalette } from './ui';

export function WorkspaceHeader({
  title,
  onOpenDrawer,
  onOptions,
  canGoBack = false,
  onGoBack,
}: {
  title?: string;
  onOpenDrawer?: () => void;
  onOptions?: () => void;
  canGoBack?: boolean;
  onGoBack?: () => void;
}) {
  const p = usePalette(), insets = useSafeAreaInsets();

  return (
    <View
      style={{
        height: insets.top + 76,
        paddingTop: insets.top + 16,
        paddingHorizontal: Math.max(insets.left, insets.right, 15),
        backgroundColor: p.canvas,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {canGoBack && onGoBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={() => {
              void Haptics.selectionAsync().catch(() => undefined);
              onGoBack();
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
            <Icon name="Back" color={p.ink} size={23} />
          </Pressable>
        ) : onOpenDrawer ? (
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
          </Pressable>
        ) : null}

        {Boolean(title) && (
          <Text style={{ color: p.ink, fontSize: 18, fontWeight: '600', marginLeft: 4 }}>
            {title}
          </Text>
        )}
      </View>

      {onOptions && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Options"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => undefined);
            onOptions();
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
          <Icon name="More" color={p.ink} size={25} />
        </Pressable>
      )}
    </View>
  );
}

