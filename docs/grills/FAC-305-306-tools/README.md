# Probes used by the FAC-305/306/310 arena

The code files end in `.txt` so the repo's typecheck and tests skip them (same convention as `FAC-170-prototype/`). Copy the folder somewhere and drop the `.txt` suffix before running.

Run from the repo root with Playwright's Chromium (Chrome for Testing), headed:

```sh
export CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
export SCRATCH=$(mktemp -d)   # throwaway profiles go here
LINKLOG_ORIGINS=https://linklog.facundopri.com bun run extension:package
mkdir -p "$SCRATCH/zip" && unzip -q -o apps/extension/linklog-extension-*.zip -d "$SCRATCH/zip"
```

| Script | What it shows |
| --- | --- |
| `warnings.ts warn-ext variants.json "$SCRATCH/zip"` | Chrome's install warnings for each manifest in `variants.json` (`chrome.management.getPermissionWarningsByManifest`, through the `warn-ext` probe extension), plus what `chrome://extensions` lists for the real build. |
| `startup-read.ts "$SCRATCH/zip"` | What the extension stores about tabs in a fresh profile without ever opening Linklog, and its network requests. |
| `consent-probe.ts "$SCRATCH/zip" <shots-dir>` | With the consent gate: the bridge's answers and the storage before and after clicking **Accept and connect** (a fake Linklog page is routed on the production origin, so the real bridge injects). |
| `python3 -I iconbox.py <png>` | Size and bounding box of the non-transparent pixels of an icon. |
