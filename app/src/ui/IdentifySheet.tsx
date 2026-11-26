// Identify an unknown thermometer (spec §6). Nothing connects or writes before
// "Try protocols". Capture stays reachable from every step.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { IdentifySession } from '../engine/identify';
import { fahrenheitToCelsius, tempUnit } from '../state/temperature';
import { font, useColors } from '../theme/tokens';
import { PrimaryButton, SheetPage, card } from './components';

export function IdentifySheet({ session, deviceName, celsius, onMatched, onCapture, onClose }: {
  session: IdentifySession;
  deviceName: string;
  celsius: boolean;
  onMatched: (adapter: { id: string; name: string }) => void;
  onCapture: () => void;
  onClose: () => void;
}) {
  const c = useColors();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const matched = useRef(onMatched);
  matched.current = onMatched;

  useEffect(() => () => void session.cancel(), [session]);
  useEffect(() => {
    if (state.phase === 'matched' && state.adapter) matched.current(state.adapter);
  }, [state.phase, state.adapter]);

  const body = { ...font.ui(15), color: c.fg2 };
  const headline = { ...font.display(24), color: c.fg1, textAlign: 'center' as const };
  const capture = (title: string, kind: 'primary' | 'bordered' | 'ghost') => (
    <PrimaryButton title={title} kind={kind} fullWidth onPress={onCapture} />
  );
  const reading = state.readingF === null
    ? '—'
    : `${(celsius ? fahrenheitToCelsius(state.readingF) : state.readingF).toFixed(1)}${tempUnit(celsius)}`;

  const content = () => {
    switch (state.phase) {
      case 'intro':
        return (
          <>
            <Text style={body}>
              BBQlaw will connect and try the thermometer protocols it knows. Only do this with your own thermometer.
            </Text>
            <PrimaryButton title="Try protocols" fullWidth onPress={() => session.start()} />
            {capture('Record capture instead', 'bordered')}
          </>
        );
      case 'confirm':
        return (
          <>
            <View style={[card(c), { alignItems: 'center', gap: 6, padding: 22 }]}>
              <Text style={{ ...font.ui(15, '600'), color: c.fg2 }}>It reads</Text>
              <Text style={{ ...font.display(64), fontVariant: ['tabular-nums'], color: c.ember }}>{reading}</Text>
              <Text style={{ ...font.ui(15, '600'), color: c.fg2 }}>now.</Text>
            </View>
            <Text style={[body, { textAlign: 'center' }]}>Does that match the thermometer's screen?</Text>
            <PrimaryButton title="Yes" fullWidth onPress={() => session.confirm(true)} />
            <PrimaryButton title="No" kind="bordered" fullWidth onPress={() => session.confirm(false)} />
          </>
        );
      case 'noMatch':
        return (
          <>
            <Text style={headline}>BBQlaw couldn't read this thermometer yet.</Text>
            <Text style={[body, { textAlign: 'center' }]}>
              None of the protocols it knows worked. A recording helps us add yours.
            </Text>
            {capture('Record capture', 'primary')}
          </>
        );
      case 'error':
        return (
          <>
            <Text style={[body, { color: c.danger, textAlign: 'center' }]}>{state.error}</Text>
            <PrimaryButton title="Try again" fullWidth onPress={() => session.start()} />
            {capture('Record capture instead', 'bordered')}
          </>
        );
      default: {
        const docked = state.phase === 'docked';
        return (
          <>
            <View style={[card(c), { alignItems: 'center', gap: 12, padding: 24 }]}>
              <ActivityIndicator size="large" color={c.ember} />
              <Text style={headline}>
                {docked ? 'Take the probe out of the base' : state.adapter ? `Trying ${state.adapter.name}…` : 'Connecting…'}
              </Text>
              {state.adapter && !docked ? (
                <Text style={{ ...font.mono(13), color: c.fg3 }}>protocol {state.trial} of {state.trials}</Text>
              ) : null}
            </View>
            <Text style={[body, { textAlign: 'center' }]}>
              {docked ? 'BBQlaw needs a live temperature to check.' : 'Each protocol takes up to 30 seconds. Keep the thermometer nearby.'}
            </Text>
            {capture('Record capture instead', 'ghost')}
          </>
        );
      }
    }
  };

  return (
    <SheetPage title="Find out how to read this thermometer" closeLabel="Close" onClose={onClose}>
      <Text style={{ ...font.ui(13, '600'), color: c.fg3, paddingBottom: 12 }}>{deviceName}</Text>
      <View style={{ gap: 14 }}>{content()}</View>
    </SheetPage>
  );
}
