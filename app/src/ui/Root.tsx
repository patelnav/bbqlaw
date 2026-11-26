// The main screen. One modal holds every sheet, so switching sheets never races.
import * as Updates from 'expo-updates';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Modal, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { Services } from '../services';
import type { CaptureAdvertisement } from '../engine/capture';
import { hasTarget, isReached } from '../state/probe';
import type { DiscoveredDevice } from '../state/store';
import { useColors } from '../theme/tokens';
import { AddDeviceScreen } from './AddDeviceScreen';
import { CaptureSheet } from './CaptureSheet';
import { Logo } from './Logo';
import { MeatSheet } from './MeatSheet';
import { ScannerSheet } from './ScannerSheet';
import { SettingsSheet } from './SettingsSheet';
import { Icon } from './icons';
import { BatteryTiles, FreshnessLine, HeroTemp, ProbeRail, Sparkline, StatusPill, TargetCard } from './monitoring';
import { statusPill } from './statusPill';

export type Sheet =
  | { kind: 'scanner' }
  | { kind: 'meat'; probeId: string }
  | { kind: 'settings' }
  | { kind: 'capture'; device: DiscoveredDevice; unreadable: boolean };

const advertisementOf = (d: DiscoveredDevice): CaptureAdvertisement => ({
  name: d.advertisedName,
  rssi: d.rssi,
  services: d.services,
  manufacturerData: d.manufacturerData,
  serviceData: d.serviceData,
});

/** A whisper of ember from the top; stronger when the target is reached. */
function Glow({ reached }: { reached: boolean }) {
  const c = useColors();
  const { width, height } = useWindowDimensions();
  return (
    <Svg pointerEvents="none" width={width} height={height} style={{ position: 'absolute' }}>
      <Defs>
        <RadialGradient id="glow" gradientUnits="userSpaceOnUse" cx={width / 2} cy={-0.12 * height} fx={width / 2} fy={-0.12 * height} r={reached ? 520 : 420}>
          <Stop offset="0" stopColor={c.emberFlat} stopOpacity={reached ? 0.16 : 0.045} />
          <Stop offset="1" stopColor={c.emberFlat} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={width} height={height} fill="url(#glow)" />
    </Svg>
  );
}

export function Root({ services, initialSheet = null }: { services: Services; initialSheet?: Sheet | null }) {
  const { store, manager, bridge } = services;
  const c = useColors();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const bridgeState = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const { isUpdatePending } = Updates.useUpdates();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(initialSheet);

  const { probes, useCelsius: celsius, connectRequest, unsupportedDevice } = state;
  const active = probes.find((p) => p.id === selectedId) ?? probes[0];
  const monitoring = probes.some((p) => p.connection === 'connected');

  // Select a new card only after a user-initiated connect.
  useEffect(() => {
    if (connectRequest !== null) setSelectedId(connectRequest);
  }, [connectRequest]);

  useEffect(() => {
    if (!unsupportedDevice) return;
    setSheet({ kind: 'capture', device: unsupportedDevice, unreadable: true });
    manager.dismissUnsupported();
  }, [unsupportedDevice, manager]);

  const captureDevice = sheet?.kind === 'capture' ? sheet.device : null;
  const capture = useMemo(
    () => (captureDevice ? services.createCapture(captureDevice.id, advertisementOf(captureDevice)) : null),
    [captureDevice, services],
  );

  const close = () => {
    if (sheet?.kind === 'scanner') manager.stopScan();
    setSheet(null);
  };
  const openScanner = () => setSheet({ kind: 'scanner' });
  const removeProbe = (id: string) => {
    manager.removeProbe(id);
    if (store.probes.length === 0 && sheet?.kind === 'settings') setSheet(null);
  };

  const sheetContent = () => {
    switch (sheet?.kind) {
      case 'scanner':
        return (
          <ScannerSheet discovered={state.discovered} onClose={close}
            onScan={() => {
              if (!store.getSnapshot().scanning) manager.startScan();
            }}
            onConnect={(device) => {
              manager.connect(device);
              setSheet(null);
            }}
            onCapture={(device) => {
              manager.stopScan();
              setSheet({ kind: 'capture', device, unreadable: false });
            }} />
        );
      case 'meat':
        return (
          <MeatSheet probe={store.probe(sheet.probeId)} celsius={celsius} onClose={close}
            onApply={(meatKey, doneness, target) => {
              store.setCook(sheet.probeId, meatKey, doneness, target);
              setSheet(null);
            }} />
        );
      case 'settings':
        return (
          <SettingsSheet probes={probes} activeId={active?.id} celsius={celsius} bridge={bridgeState}
            updateLabel={services.updateLabel} updatePending={isUpdatePending}
            onUpdateLibrary={services.updateLibraryNow} onRestartToUpdate={services.restartToUpdate} onClose={close}
            onUnits={(value) => store.setUseCelsius(value)}
            onSelectProbe={(id) => {
              setSelectedId(id);
              setSheet(null);
            }}
            onAddDevice={openScanner}
            onRemoveProbe={removeProbe}
            onBaseMuted={(id, muted) => store.setBaseMuted(id, muted)}
            onPair={() => bridge.pair()}
            onUnlink={() => void bridge.unlink()} />
        );
      case 'capture':
        return capture ? (
          <CaptureSheet key={sheet.device.id} session={capture} deviceName={sheet.device.name} unreadable={sheet.unreadable}
            onUpload={services.uploadCapture} onShare={services.shareCapture} onClose={close} />
        ) : null;
      default:
        return null;
    }
  };

  const status = statusPill(state.bluetoothOff, probes, active);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Glow reached={active ? isReached(active) : false} />
        <SafeAreaView style={{ flex: 1 }}>
          {monitoring && active ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 6, paddingBottom: 14 }}>
                <Logo size={21} />
                <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => setSheet({ kind: 'settings' })}
                  style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
                  <Icon name="gearshape" size={21} color={c.fg2} weight={1.7} />
                </Pressable>
              </View>
              <StatusPill status={status} />
              <FreshnessLine lastReadingAt={active.lastReadingAt} />
              <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
                contentContainerStyle={{ gap: 13, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 22 }}>
                <HeroTemp probe={active} celsius={celsius} />
                {active.mode === 'live' && active.recentTemps.length >= 2 ? (
                  <Sparkline samples={active.recentTemps} color={hasTarget(active) ? c.ember : c.tempCool} />
                ) : null}
                {probes.length > 1 ? (
                  <ProbeRail probes={probes} activeId={active.id} celsius={celsius} onSelect={setSelectedId} onAdd={openScanner} />
                ) : null}
                {active.capabilities.includes('battery') ? <BatteryTiles probe={active} /> : null}
                <TargetCard probe={active} celsius={celsius}
                  canRemove={new Set(probes.map((p) => p.deviceId)).size > 1}
                  onRename={(id, name) => store.setName(id, name)}
                  onAlarmEnabled={(enabled) => store.setAlarmEnabled(active.id, enabled)}
                  onTarget={(target) => store.setTarget(active.id, target)}
                  onOpenMeat={() => setSheet({ kind: 'meat', probeId: active.id })}
                  onRemove={() => removeProbe(active.id)} />
              </ScrollView>
            </>
          ) : (
            <AddDeviceScreen pairingLabel={probes.length > 0 ? status.label : null} bluetoothOff={state.bluetoothOff} onScan={openScanner} />
          )}
        </SafeAreaView>
      </View>
      <Modal visible={sheet !== null} animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={close}>
        {sheetContent()}
      </Modal>
    </SafeAreaProvider>
  );
}
