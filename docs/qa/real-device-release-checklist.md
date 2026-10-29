# Real-device release checklist

> **Stub.** Mobile slice 10 owns this document and fills in the browsers, the devices and every
> other device-only item from the mobile PRD's Testing Decisions. Until then it carries only the
> items that slices which landed earlier handed to it. Each item names its rubric ID and the slice
> that owns it. Keep that tagging when slice 10 restructures the page.

Run these on real hardware. The Playwright mobile gate cannot show them: emulated Chromium applies
its forced dark mode whatever the page declares, and it has no Home Screen, no Safari toolbar and no
physical rotation.

## Installed app: head and manifest (slice 06)

| # | Item | Rubric | Owner | Where | Pass |
|---|------|--------|-------|-------|------|
| 06-1 | **Forced dark mode.** Turn on the browser's forced dark mode (Samsung Internet: dark mode with "dark theme sites" on; Chrome on Android: `chrome://flags` auto dark mode for web contents). Open the sign-in page and a signed-in page. | PWA-06 | slice 06 | Samsung Internet and Chrome on Android | The UI keeps its light colours. Nothing is inverted. The page declares `color-scheme: only light`, which is the opt-out. |
| 06-2 | **Toolbar tint.** Open the app in Safari on an iPhone, in a tab and from the Home Screen, and scroll a long page. | PWA-06 | slice 06 | iOS Safari (tab and standalone) | The toolbar and status-bar area are white, matching the app header (`--app`, `#ffffff`). No dark band or mismatched strip. |
| 06-3 | **Home Screen icon.** Add the app to the Home Screen on an iPhone and install it on Android. | PWA-01 | slice 06 | iOS Safari, Chrome on Android | The icon is the ServWave mark: the 180 px apple-touch-icon on iOS, and the maskable icon on Android, not cropped by the launcher's shape. There is no screenshot fallback and no third-party mark. |
| 06-4 | **Rotation.** Open the installed app on Android and rotate the phone to landscape and back. | A11Y-01 | slice 06 | Chrome on Android, installed | The app follows the device into landscape. Nothing locks it to portrait and no "rotate your device" message appears. |
