# OTA updates: operator commands

The app gets signed Expo Updates (iOS only) from `https://updates.bbqlaw.app`.
`updates-worker/` serves them from the R2 bucket `bbqlaw-updates`. The Worker is
read-only and holds no keys. This Mac signs each update.

## One-time setup

1. Create the bucket and deploy the host.

   ```bash
   cd updates-worker && npm install
   npx wrangler r2 bucket create bbqlaw-updates
   npx wrangler deploy
   ```

2. In the Cloudflare DNS for `bbqlaw.app`, add a **proxied** record: type `AAAA`,
   name `updates`, content `100::`. The Worker route needs this record.
3. Check the host: `curl https://updates.bbqlaw.app/health` returns `{"ok":true}`.
4. Create the signing key and certificate. Do this before the first store build.

   ```bash
   cd app && node --experimental-strip-types scripts/ota-keygen.ts
   ```

   - The private key is `~/.config/bbqlaw/ota-private-key.pem` (mode 0600).
     Back it up. Never commit it.
   - Commit `app/updates/certificate.pem`.
   - The script never overwrites a file. A new certificate needs a new store build.

## Publish

Run all commands from `app/`. They need `npm install` in `app/` and in
`updates-worker/`, and a `wrangler login`.

`alias ota='node --experimental-strip-types scripts/publish-ota.ts'`

| Task | Command |
|------|---------|
| Publish to preview | `ota publish --channel preview --app <preview BBQlaw.app>` |
| Publish to production | `ota publish --channel production --app <production BBQlaw.app>` |
| Promote preview to production | `ota promote --from preview --to production --app <preview .app> --to-app <production .app>` |
| Publish old code again | `ota rollback --channel production --to <updateId>` |
| Return to the store bundle | `ota embedded --channel production --app <production BBQlaw.app>` |

Each publish prints the update id. Keep it for `rollback`.

## Runtime version

The host serves an update only when its runtime version equals the fingerprint
that the installed build sends.

- With `--app`, the script reads `EXUpdates.bundle/fingerprint` from that built
  `.app`. This is the value that the build sends. Use it when you can. For a store
  build, use the `.app` in `<archive>.xcarchive/Products/Applications/`.
- Without `--app`, the script runs
  `EXPO_UPDATES_WORKFLOW_OVERRIDE=managed npx expo-updates runtimeversion:resolve --platform ios`
  with `BBQLAW_CHANNEL` set to the channel. Before you rely on this, check that it
  equals the embedded value. If they differ, the app receives nothing.

The channel header is part of the app config and of `Expo.plist`, so preview and
production builds can have different runtime versions. Then `promote` stops with
an error. Run `publish --channel production` from the same commit instead.

## Safety

- One operator publishes at a time. `wrangler` has no conditional writes.
- The channel pointer is written last. A failed publish leaves the channel as it was.
- `promote` and `rollback` accept only releases that the current certificate signed.
- Test the host and publisher: `cd updates-worker && npm test && npm run typecheck`.
