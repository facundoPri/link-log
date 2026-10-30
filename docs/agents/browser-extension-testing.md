# Test the extension from the current worktree

Use this procedure when a change touches Browser, the extension, or the shared
browser protocol. Build and run the app and extension from the same worktree.
An extension installed from `main` does not verify a feature worktree.

## Use the worktree launcher

On macOS, run these commands from the checkout that owns the change:

```sh
bun run extension:ego up
bun run extension:ego status
bun run extension:ego down
bun run extension:ego:clean
```

`up` rebuilds `apps/extension/dist` and starts Ego Lite with that extension,
an isolated profile, and a browser service named from the worktree path.
Repeat `up` after edits. It stops its previous browser and rebuilds before
starting again, so the extension background and content scripts reload together.

Complete Ego's onboarding once in the isolated window. If onboarding is pending,
the command exits with an error and keeps the window available. After completing
onboarding, run `status` to verify installation. An unsupported `--load-extension`
also fails verification; do not treat an opened window as a successful install.

To open this worktree's already-running app, set its URL:

```sh
LINKLOG_URL=http://127.0.0.1:3400 bun run extension:ego up
```

The launcher does not start the app or sign in. Use the isolated app setup from
`verify-linklog` separately. An enabled extension is not proof of the Browser
handshake or a feature result.

Use the named service printed by `up` for subsequent browser automation:

```sh
ego-browser --ego-server-name=<printed-service> nodejs -e 'console.log(await listTaskSpaces())'
```

`status` checks source and build hashes, then verifies the loaded absolute path
and enabled state through `chrome://extensions`. It saves installation evidence
to `.cache/ego-extension/verification.json`. Use the same build environment
variables when running `up` and `status`.

`down` stops only the browser whose executable, profile, and service match the
worktree receipt. It preserves the profile for reuse. `clean` also removes that
QA profile; onboarding is required again afterward. Both commands preserve the
extension build, receipts, screenshots, other worktrees, and personal profiles.
Cleanup refuses a browser with another task space or a space under user control.

The default executable is `/Applications/ego lite.app/Contents/MacOS/ego lite`.
Set `EGO_LITE_BINARY` if Ego is installed elsewhere. Unset `LINKLOG_EXTENSION_OUT`;
the launcher always builds the owning worktree's `apps/extension/dist`.

## Load into an existing browser manually

Use the manual steps below only when you need to use an existing Ego window.
The automated launcher uses its own window and does not modify that installation.

## Build the worktree extension

Run these commands from the checkout that owns the change:

```sh
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
bun install --frozen-lockfile
bun run extension:build
```

Load the absolute `<worktree>/apps/extension/dist` directory. Do not load
`apps/extension/src`, a release ZIP, another worktree's `dist`, or a copy in a
shared temporary directory. Record any `LINKLOG_ORIGINS` and `LINKLOG_UI_PORT`
overrides used for the build. Localhost and 127.0.0.1 bridges support any port;
the UI port controls the extension's **Open Linklog** destination.

## Load it in Ego Lite

1. Read the `ego-browser` skill and run `ego-browser skill` for the installed guide.
2. Create one task space for this QA session. Give parallel sessions their own
   spaces. Keep ownership of extension loading and reloading with one session.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select the absolute worktree `dist` directory.
   If a native chooser or permission prompt cannot be handled through the
   supported browser API, hand control to the user. Do not bypass the prompt.
5. Open the extension's **Details**. Verify its source path, ID, enabled state,
   and errors. The version number alone is insufficient; different worktrees
   can produce the same version. Do not disable unrelated extensions.
6. Open this worktree's Linklog instance in the same browser window as the QA
   tabs. Complete Connect and verify Browser actually lists those tabs. Keep
   test tabs separate from personal tabs; the extension operates on a window.

If another Linklog build can answer the same bridge in that window, use a
dedicated QA browser/window and ensure only the intended Linklog build is
active there before proceeding. Preserve other sessions' installations.

## Rebuild and reload after edits

After changing extension code, the shared protocol, or build configuration:

1. Run `bun run extension:build` in the owning worktree. A successful watch
   rebuild also updates `dist`, but does not reload the installed extension.
2. Reload that exact extension in `chrome://extensions`.
3. Reload the Linklog page so it gets the current bridge content script, then
   reconnect Browser. If app code changed, restart/rebuild the owning app too.
4. Verify the extension path and Browser handshake again before retesting.

Reloading the extension resets its session storage and can discard lens results
and browser-session state. Recreate the test setup after reload. Reloading only
the Linklog page does not update the extension background worker.

## Verify the behavior

Run `bun run test:browser` from the worktree for the existing isolated Chromium
extension integration checks. Use the `verify-linklog` skill for isolated web
UI/API proof; that harness does not install or verify the Ego Lite extension.
For an Ego Lite check, connect the actual extension to the owning worktree's
isolated app and drive the feature through its UI.

For bulk open, verify selected URLs open as real tabs in the intended window,
unavailable/disconnected behavior, partial failures, and existing selection
actions. Record the actual tab URLs/count before and after the action. State
which cases use fixtures or mocks and which use the real extension.

## Keep evidence tied to the build

Store the following in the worktree's QA report:

- Worktree absolute path, branch, HEAD, and dirty source state.
- Build command, build time, configured origins, and app URL/ports.
- Absolute loaded `dist` path, enabled extension ID, and browser version.
- SHA-256 hashes of the generated manifest and JavaScript files used in the run.
- Reload/reconnect time, screenshots of extension identity and Browser connection,
  and feature results with before/after state.
- Checks that passed, failures, and cases not exercised.

Hash the loaded files immediately before the run and compare them afterward.
If source or generated files changed during the run, rebuild, reload, reconnect,
and repeat affected checks. Do not report evidence from an older build as proof
of the final code.

At cleanup, stop only the isolated app you started and close only your task
space's test pages. Leave another session's app, extension, and pages alone.
