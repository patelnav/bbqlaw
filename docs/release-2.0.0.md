# BBQlaw 2.0.0 (build 4): release notes for Nav

## App Store "What's New"

> BBQlaw 2.0 is rebuilt, so we can add thermometers and fixes faster.
>
> • If BBQlaw can't read your thermometer, you can record 60 seconds of its
> Bluetooth data and send it to us. Nothing is sent unless you tap Send.
>
> After this update, add your probe again. If you linked an agent, tap Link again.

## App Privacy label

Add one entry in App Store Connect:

| Field | Value |
|---|---|
| Data type | Diagnostics → Other Diagnostic Data |
| Why it is collected | Captures that the user chooses to send |
| Linked to the user | No |
| Used for tracking | No |
| Purpose | App Functionality |

The app's privacy manifest already declares this entry. The 1.0 manifest declared
no collected data. Keep your other answers as they are.

## Behavior changes that we accept

1. **Add the probe again, once.** 1.0 saved cooks do not carry over. Probe names,
   targets, meat choices, mute and Watch only settings start fresh. The °F/°C
   choice returns to °F.
2. **Link your agent again, once.** The new app cannot read the link that 1.0 saved
   (tested in the Simulator). Give your agent the new feed link.
3. **Cold relaunch shows a notification.** If iOS relaunches the app in the
   background for Bluetooth, BBQlaw cannot read the probe until you open it. It
   shows "Open BBQlaw to keep watching".

## Device check #2 (your iPhone, Release build)

To install: see "Build and run" in the README. If you can, open the App Store 1.0
app once and then install 2.0 over it.

- [ ] The app opens after the upgrade. It does not show a black screen.
- [ ] Allow Bluetooth and notifications.
- [ ] Scan. The INT-11I-B is under **Supported**. It connects and shows a live
      temperature and both battery levels.
- [ ] Set a target a little above the current temperature.
- [ ] **Background cook, 1 hour or more, screen locked.** At the end, the
      temperature is current when you open the app.
- [ ] **Alarm:** with the screen locked, warm the probe past the target. One
      notification arrives.
- [ ] **Re-arm:** cool the probe more than 2°F below the target, then warm it
      again. A second notification arrives.
- [ ] **Buzzer:** the base sounds at the target. The speaker button in Settings
      mutes it and turns it on again.
- [ ] **Watch only:** turn it on. No app alert arrives, the base target clears and
      the buzzer is muted. Turn it off. Your target returns.
- [ ] **Link:** tap Link & copy. The feed shows live readings with the screen
      locked, and the target event.
- [ ] Dock the probe: the app shows **Docked**. Take it out: readings return.
- [ ] Move out of range and come back: the app reconnects by itself.
- [ ] **Capture:** tap a device under **Other Bluetooth devices**, record, tap
      **Send to BBQlaw**, and keep the reference code.
- [ ] If you see "Open BBQlaw to keep watching", open the app. It reconnects.
      (iOS decides when this happens, so you cannot force it.)

## Before you submit

- [ ] Deploy `web/` again. On 2026-11-26 the live privacy page did not yet have
      the paragraph about captures and 90-day deletion.
- [ ] Confirm that your test capture is in the list (see "Captures" in the
      README). The capture endpoint is live and rejects requests without a token.
- [ ] Confirm that the 90-day lifecycle rule exists on `bbqlaw-captures`
      (command in `relay/README.md`).
- [ ] Back up `~/.config/bbqlaw/ota-private-key.pem`.
- [ ] Build from the committed `app/ios/`. Do not run `prebuild --clean` first,
      because it changes the runtime fingerprint (see the README).
- [ ] Archive the production build: do not set `BBQLAW_CHANNEL`.
- [ ] Keep the `.app` from that archive. `publish-ota --app` needs it for every
      production update.
- [ ] A preview TestFlight build is separate. Set `BBQLAW_CHANNEL=preview` for
      both `expo prebuild` and the build. Do not commit the changed `Expo.plist`.
