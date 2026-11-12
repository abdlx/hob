import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Icon } from './icons';
import type { IconName } from './icons';
import { usePalette } from './ui';

export interface MobileDockItem {
  id: 'Chat' | 'Activity' | 'Workshop' | 'Goals' | 'Library';
  label: string;
  icon: IconName;
}

export const primaryNavigation: MobileDockItem[] = [
  { id: 'Chat', label: 'Chat', icon: 'MessageCircle' },
  { id: 'Activity', label: 'Activity', icon: 'PanelsTopLeft' },
  { id: 'Workshop', label: 'Workshop', icon: 'Lightbulb' },
  { id: 'Goals', label: 'Goals', icon: 'SquareCheck' },
  { id: 'Library', label: 'Library', icon: 'Shapes' },
];

export function MobileDock({
  currentTab,
  onNavigate,
  hidden = false,
}: {
  currentTab: string;
  onNavigate: (tab: MobileDockItem['id']) => void;
  hidden?: boolean;
}) {
  const p = usePalette(), insets = useSafeAreaInsets();
  if (hidden) return null;

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="Mobile navigation"
      style={{
        width: '100%',
        height: 72 + insets.bottom,
        backgroundColor: p.canvas,
        flexDirection: 'row',
        justifyContent: 'space-evenly',
        alignItems: 'center',
        paddingHorizontal: 28,
        paddingTop: 4,
        paddingBottom: insets.bottom,
        borderTopWidth: 0,
      }}
    >
      {primaryNavigation.map(item => {
        const active = currentTab === item.id;
        const color = active ? p.ink : p.iconIdle;
        const fill = active ? (item.id === 'Chat' || item.id === 'Goals' || item.id === 'Library' ? color : undefined) : undefined;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: active }}
            onPress={() => {
              void Haptics.selectionAsync().catch(() => undefined);
              onNavigate(item.id);
            }}
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              minWidth: 44,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name={item.icon} size={25} color={color} strokeWidth={1.9} fill={fill} />
          </Pressable>
        );
      })}
    </View>
  );
}

