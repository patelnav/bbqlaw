// Capture and opt-in upload (adapter-engine.md §10, spec §7). Nothing leaves the
// phone without a tap.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Text, View } from 'react-native';
import { type CaptureDocument, type CaptureSession } from '../engine/capture';
import { font, useColors } from '../theme/tokens';
import { PrimaryButton, SheetPage, card } from './components';

export const UNSUPPORTED_COPY = "BBQlaw can't read this thermometer yet.";

export function CaptureSheet({ session, deviceName, unreadable, onUpload, onShare, onClose }: {
  session: CaptureSession;
  deviceName: string;
  /** Opened because a matched device did not fit its adapter. */
  unreadable: boolean;
  onUpload: (document: CaptureDocument) => Promise<string>;
  onShare: (document: CaptureDocument, fileName: string) => Promise<void>;
  onClose: () => void;
}) {
  const c = useColors();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') void session.end('background');
    });
    return () => {
      subscription.remove();
      void session.end('dismissed');
    };
  }, [session]);

  const body = { ...font.ui(15), color: c.fg2 };
  const small = { ...font.ui(13), color: c.fg3, textAlign: 'center' as const };
  const failure = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const result = state.result;

  return (
    <SheetPage title="Help add this thermometer" closeLabel={state.phase === 'recording' ? 'Cancel' : 'Close'} onClose={onClose}>
      <Text style={{ ...font.ui(13, '600'), color: c.fg3, paddingBottom: 12 }}>{deviceName}</Text>
      {state.phase === 'intro' ? (
        <View style={{ gap: 16 }}>
          {unreadable ? <Text style={{ ...font.ui(17, '700'), color: c.fg1 }}>{UNSUPPORTED_COPY}</Text> : null}
          <Text style={body}>
            {unreadable ? '' : "BBQlaw doesn't support this thermometer yet. "}
            Record 60 seconds of its Bluetooth data and send it to us. BBQlaw only listens; it sends nothing to the thermometer.
          </Text>
          <PrimaryButton title="Start recording" fullWidth onPress={() => session.start()} />
        </View>
      ) : state.phase === 'done' && result ? (
        <View style={{ gap: 12 }}>
          <View style={[card(c), { alignItems: 'center', gap: 4, padding: 18 }]}>
            <Text style={{ ...font.display(26), color: c.fg1 }}>Capture ready</Text>
            <Text style={{ ...font.mono(13), color: c.fg3 }}>{result.document.events.length} packets</Text>
          </View>
          {code === null ? (
            <>
              <PrimaryButton title="Send to BBQlaw" fullWidth busy={sending} onPress={() => {
                setSending(true);
                setError(null);
                onUpload(result.document).then(setCode, failure).finally(() => setSending(false));
              }} />
              <Text style={small}>
                Sends this thermometer's Bluetooth name, layout and readings to BBQlaw. No account or location. Deleted after 90 days.
              </Text>
            </>
          ) : (
            <View style={[card(c), { alignItems: 'center', gap: 6, padding: 18 }]}>
              <Text style={body}>Sent. Your reference code is</Text>
              <Text selectable style={{ ...font.mono(18, '700'), color: c.ember }}>{code}</Text>
            </View>
          )}
          {error ? <Text style={{ ...small, color: c.danger }}>{error}</Text> : null}
          <PrimaryButton title="Share file" kind="bordered" fullWidth onPress={() => {
            onShare(result.document, result.fileName).catch(failure);
          }} />
          <PrimaryButton title="Done" kind="ghost" fullWidth onPress={onClose} />
        </View>
      ) : (
        <View style={{ gap: 16, alignItems: 'stretch' }}>
          <View style={[card(c), { alignItems: 'center', gap: 4, padding: 22 }]}>
            <Text style={{ ...font.display(72), fontVariant: ['tabular-nums'], color: c.ember }}>
              {state.secondsLeft}
            </Text>
            <Text style={{ ...font.mono(13), color: c.fg3 }}>seconds left · {state.packets} packets</Text>
          </View>
          <Text style={body}>
            Use the thermometer while this runs: take the probe out, warm it in your hand, change the target on the base.
          </Text>
          <PrimaryButton title="Stop" kind="bordered" fullWidth onPress={() => void session.end('stop')} />
        </View>
      )}
    </SheetPage>
  );
}
