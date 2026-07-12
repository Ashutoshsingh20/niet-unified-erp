# Native mobile build foundation

`apps/student-mobile` and `apps/staff-mobile` are separate React Native CLI 0.85 projects with native Android and iOS targets. They do not use Expo hosted build, update, authentication, storage, or notification services.

## Supported verification

Run the repository on Node 24 LTS, then:

```sh
npm ci
npm run typecheck --workspace @niet/student-mobile
npm run lint --workspace @niet/student-mobile
npm test --workspace @niet/student-mobile -- --runInBand
npm run typecheck --workspace @niet/staff-mobile
npm run lint --workspace @niet/staff-mobile
npm test --workspace @niet/staff-mobile -- --runInBand
```

For Android, install the SDK/NDK required by React Native and run `ANDROID_HOME=/approved/sdk/path ./gradlew assembleDebug` from each app's `android` directory. The checked-in Gradle configuration resolves hoisted monorepo dependencies without machine-specific `local.properties`.

For iOS, use an NIET-managed Mac with the approved Xcode version, run `bundle install` and `bundle exec pod install` inside the app's `ios` directory, then build the workspace with signing disabled for CI or with NIET-managed signing for distribution. App Store provisioning and device testing remain external acceptance gates.

## Security posture

- Preview screens contain no institutional records or production mock data.
- Production identity/API access, biometric unlock, encrypted offline cache, device binding, certificate trust, remote revocation, and notification posture remain disabled until D-01, D-02, D-03, and D-10 are approved.
- Notification payloads may contain only an opaque event identifier; records must be fetched from NIET after authentication.
- High-risk payroll, bulk results, role administration, financial close, and similar operations remain web-only.
- No restricted data may be stored in plaintext local storage. Adding any offline store requires a threat model, platform-keystore encryption, bounded retention, logout/revocation deletion, and tests before use.
