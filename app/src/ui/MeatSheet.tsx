import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { MEATS, type Meat, type Probe } from '../state/probe';
import { formatTemp, tempUnit } from '../state/temperature';
import { font, radius, useColors } from '../theme/tokens';
import { SheetPage } from './components';
import { Icon } from './icons';

export function MeatSheet({ probe, celsius, onApply, onClose }: {
  probe: Probe | undefined;
  celsius: boolean;
  onApply: (meatKey: string, doneness: string | null, target: number | null) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const [expanded, setExpanded] = useState(probe?.meatKey ?? null);

  const rightLabel = (meat: Meat) =>
    meat.doneness ? '5 levels' : meat.key === 'custom' ? 'Set on slider' : `${formatTemp(meat.target, celsius)}${tempUnit(celsius)}`;

  const press = (meat: Meat) => {
    if (meat.doneness) setExpanded(expanded === meat.key ? null : meat.key);
    else if (meat.key === 'custom') onApply('custom', null, probe?.targetF ?? 165);
    else onApply(meat.key, null, meat.target);
  };

  return (
    <SheetPage title="What are you cooking?" closeLabel="Cancel" onClose={onClose}>
      <View style={{ gap: 8 }}>
        {MEATS.map((meat) => {
          const selected = meat.key === expanded;
          const accent = selected ? c.ember : c.fg3;
          return (
            <View key={meat.key} style={{ gap: 8 }}>
              <Pressable accessibilityRole="button" onPress={() => press(meat)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14, borderRadius: radius.md, borderWidth: 1, backgroundColor: selected ? c.emberTint : c.surface2, borderColor: selected ? c.ember : c.line }}>
                <Text style={{ ...font.ui(16, '700'), flex: 1, color: c.fg1 }}>{meat.name}</Text>
                <Text style={{ ...font.ui(14, '600'), color: accent }}>{rightLabel(meat)}</Text>
                {meat.doneness ? (
                  <View style={{ transform: [{ rotate: selected ? '90deg' : '0deg' }] }}>
                    <Icon name="chevronRight" size={15} color={accent} weight={2.4} />
                  </View>
                ) : selected ? <Icon name="sealCheck" size={17} color={c.ember} /> : null}
              </Pressable>
              {selected && meat.doneness ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 4, paddingBottom: 4 }}>
                  {meat.doneness.map((level) => {
                    const picked = probe?.meatKey === meat.key && probe.doneness === level.label;
                    return (
                      <Pressable key={level.label} accessibilityRole="button" onPress={() => onApply(meat.key, level.label, level.f)}
                        style={{ paddingHorizontal: 13, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: c.lineStrong, backgroundColor: picked ? c.ember : c.surface }}>
                        <Text style={{ ...font.ui(14, '600'), color: picked ? c.white : c.fg1 }}>
                          {level.label} · {formatTemp(level.f, celsius)}°
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </SheetPage>
  );
}
