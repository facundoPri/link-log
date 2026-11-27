# Chrome Web Store listing: texts, permission justifications and Privacy tab

Paste-ready answers for the Developer Dashboard, for the Unlisted submission of extension 0.3.0. Source of every value: [FAC-310](https://linear.app/facundopri/issue/FAC-310) and its accepted decision, [docs/grills/FAC-310.md](grills/FAC-310.md). They depend on [FAC-305](grills/FAC-305.md) (consent gate and Connect text), [FAC-306](grills/FAC-306.md) (final manifest) and [FAC-307](grills/FAC-307.md) (privacy policy).

Rules the copy follows: no Arc claims; evaluating a tab never reads as saving it; reading page content is part of reviewing open tabs, not a separate clipper.

**Status.** The copy is a draft until the owner approves it in a comment on FAC-310. Open items are listed at the end ([Pending](#pending)).

Sections: [Store listing tab](#store-listing-tab) · [Privacy practices tab](#privacy-practices-tab) · [Checks](#checks) · [Pending](#pending)

## Store listing tab

| Field | Value to enter |
| --- | --- |
| Name | `Linklog` (from the manifest) |
| Short description | From the manifest, not editable in the dashboard (108 characters). It must equal the manifest `description`: `Review, group and save your open Chrome tabs in Linklog. It reads tab URLs and titles only after you accept.` |
| Detailed description | The block below |
| Category | Productivity (the Workflow & planning subcategory if the dashboard offers one, otherwise Tools) |
| Language | English |
| Homepage URL | `https://linklog.facundopri.com` |
| Support URL | `https://github.com/facundoPri/link-log/issues` |
| Visibility (Distribution tab) | Unlisted |
| Distribution regions (not in the accepted table; source: FAC-307 owner answer 3) | All regions except the European Economic Area, the United Kingdom and Switzerland (the policy says the beta is not offered there; FAC-307 owner answer 3) |
| Mature content (not in the accepted table; the dashboard default) | Off |
| Store icon | 128×128, from the packaged build (`icons/128.png`, FAC-306) |
| Promo tiles, video | None for the Unlisted submission |
| Screenshots | The five files in `docs/store/`, see [Screenshots](#screenshots) |

### Detailed description

Paste everything between the rules. The dashboard takes plain text, so the bold markers are dropped and the section headings are plain lines.

---
Linklog's Browser view lists the tabs open in your Chrome windows, so you can review them, group them and save the ones you want to keep.

What you can do
• See every open tab with its preview, and filter by domain.
• Turn on lenses: questions you define, answered by AI from the page, to sort tabs you want to keep from tabs you can close.
• Group, move, open and close the tabs you select, and put idle tabs to sleep.
• Save a tab to your Linklog library. Saving is a separate action; evaluating a tab with a lens doesn't save it.

What the extension reads, and when
• Nothing until you click "Accept and connect" on its Connect page.
• Then: the URL and title of every open tab, in every Chrome window, and your tab groups. The tabs of Linklog's window are shown to your Linklog page.
• Page text and previews only if you also click "Allow page content". You can remove that access on the same page.
• Page text leaves your browser only when a lens you turned on evaluates a tab, or when you auto-group tabs. Then the tab's URL, title and text go to your Linklog library, whose server sends them to a remote AI provider for the answer. Auto-grouping also sends the names and descriptions of the groups you chose.
• Linklog reloads a tab (to load its content) or puts it to sleep only when you ask.
• The name, color and description of groups you link to Linklog, and which Linklog library linked them, stay on your device, so they can be linked again after a restart.
• Saving a tab sends only its URL. Linklog then fetches the page with a remote extraction service, like any link you add.
• Never cookies, passwords or form fields. Your data isn't sold or used for ads. The providers we use are named in the privacy policy.

Permissions
• Tabs: read your open tabs (Chrome calls this "Read your browsing history").
• Tab groups: show and change the groups you choose.
• Scripting and optional site access: read the pages you allow.
• Storage: keep results and your settings.
• linklog.facundopri.com: connect to the Linklog web app.

Requirements: a Linklog account and desktop Chrome.

Privacy policy: https://linklog.facundopri.com/privacy
---

Differences from the accepted draft, so the text says what the Connect page of 0.3.0 says (acceptance criterion: "the long description and the Connect disclosure say the same things"). The Connect text is `apps/extension/src/pages/connect.html` at `34203b1`, after FAC-412:

- "every open tab, in every Chrome window" (the draft said "your open tabs").
- Auto-grouping is named next to lenses, with its URL, title and text and the group names and descriptions it also sends (FAC-412).
- "whose server sends them to a remote AI provider" (the draft said the library "uses" one).
- "reloads a tab ... or puts it to sleep only when you ask" and the line about groups staying on the device, with the library that linked them (FAC-412).
- "The providers we use are named in the privacy policy" (a sentence of the Connect text that the draft left out).

### Screenshots

Five PNGs, each 1280×800 (checked with `sips`), in [`docs/store/`](store/). Upload them in this order (Graphic assets, Screenshots). Taken on 2026-11-27 from the packaged 0.3.0 build (the `linklog-extension-0.3.0.zip` of the GitHub release `extension-v0.3.0`, loaded in a fresh Chrome for Testing 153 profile) against `https://linklog.facundopri.com`, signed in to a demo account with an empty library. The seven open tabs are public Wikipedia, MDN, Python docs and Standard Ebooks pages. No fixtures, no test profiles, no localhost.

| File | Shows |
| --- | --- |
| `01-connect-consent.png` | The Connect page's consent card ("Before Linklog reads your tabs"), before accepting. |
| `02-browser-not-connected.png` | Browser view's "Not connected yet" state. |
| `03-browser-tabs.png` | Browser view with the seven tabs and their previews, and the domain filter open. |
| `04-lens.png` | A lens ("About the sea") sorting the tabs: Yes 2, Unsure 0, No 5. No tab landed on Unsure. |
| `05-group.png` | Three selected tabs and the New group dialog (not created). |

How they were made:

- The sidebar footer of the Linklog app shows the account's email. Before each capture the page's text for the email and the avatar letter was replaced in the DOM with "Demo account" and "D", so the email appears in no image. Nothing else on the pages was edited.
- Nothing was saved to the library: the demo library still has 0 links. The demo account does hold the lens "About the sea".
- The captures use CSS pixels (the window's device scale factor was 2).
- Planned page 7 (`gutenberg.org`) was down for maintenance and was replaced by `standardebooks.org`. The MDN URL redirects to `/Web/CSS/Reference/Properties/grid`.

There are no promo tiles for the Unlisted submission.

## Privacy practices tab

### Single purpose

Paste (266 characters; the docs state no limit for this field):

```
Connects Linklog's Browser view to the tabs and tab groups of the user's Chrome windows, so they can review, group, close and save their open tabs in Linklog. Reading open pages for previews and lenses, only when the user allows page content, is part of that review.
```

### Permission justifications

One entry per permission in the 0.3.0 manifest: the four `permissions`, the two `optional_host_permissions` and the one host the bridge content script matches. The dashboard lists the permissions it finds in the uploaded manifest; paste each text into the field of the same name. The docs don't describe how host permissions are listed, so if the dashboard shows the two optional patterns as one field, paste that entry once there.

**`tabs`**

```
Browser view lists the user's open tabs so they can review them. The extension needs "tabs" to read each tab's URL, title and icon, and to group, move, open, put to sleep and close the tabs the user selects. Nothing is read until the user accepts the disclosure on the extension's Connect page. Tab URLs and titles are shown to the user's Linklog page. They leave the browser only when the user turns on a lens, auto-groups tabs or saves a tab: then the URL goes to the user's Linklog library, and for lenses and auto-grouping so do the title and the page text.
```

**`tabGroups`**

```
To show the user's tab groups in Browser view, and to create, rename, recolor, move and ungroup them when the user groups tabs from Linklog. The title, color and description of a group the user links to Linklog, and which Linklog library linked it, are kept in local storage, so the link survives a Chrome restart. For a pinned group, Linklog's page also sends that group's name, description and color (never its tabs) to the user's Linklog library.
```

**`scripting`**

```
To run code bundled in the package (the extractor extract.js and a small function that reads a page's meta tags; no remote code) in open tabs where the user granted page access, and read the title, description, preview image and page text for previews and lenses. It never runs on pages without a user-granted host permission.
```

**`storage`**

```
chrome.storage.session holds the open-tab registry, lens results per tab and the load queue, cleared when Chrome closes. chrome.storage.local holds the user's consent, an installation id, the look of linked tab groups (title, color, description and the library that linked them) and the chosen load concurrency.
```

**Optional host permissions `http://*/*` and `https://*/*`**

```
Browser view reviews whatever tabs the user has open, on any site, so the sites can't be listed in advance. Access is requested only when the user clicks "Allow page content" on the Connect page, after the disclosure, and can be removed there at any time. Chrome's Site access can also limit it to specific sites, and the extension honors that per tab. It is used only to run the bundled extractor and the bundled meta-tag reader in the tabs the user reviews: no cookies, no form fields, no history, no clicking, no scrolling, and they change nothing on the page. The extension reloads a tab (Load content) or puts it to sleep (Sleep) only when the user asks, and puts a tab it woke back to sleep afterwards. Page text leaves the browser only when a lens the user turned on evaluates a tab, or the user auto-groups tabs.
```

**Host access `https://linklog.facundopri.com/*` (bridge content script)**

```
Connects the Linklog web app to the extension. The script stays inert unless the page identifies as Linklog, and only relays validated messages between that page and the extension.
```

The optional-host text differs from the accepted draft in one clause. The draft said "no page changes, no reloading or scrolling". The code reloads a sleeping tab when the user asks to load its content (`chrome.tabs.reload` in `apps/extension/src/background/loader.ts`), and the privacy policy says so. A reviewer reading "no reloading" next to the policy would see a contradiction, so the text now says what happens. FAC-412 (#61) changed the Connect page to say the same: "Linklog reloads a tab (Load content) or puts it to sleep (Sleep) only when you ask."

### Remote code

Select **"No, I am not using remote code."**

All JavaScript is in the package. `extract.js` is injected from the package by file. The CSP is `script-src 'self'; object-src 'self'`. The extension makes no network requests itself.

### Data usage

Tick these six (the policy section that backs each one is in [Checks](#checks)):

- [x] Personally identifiable information
- [x] Authentication information
- [x] Location
- [x] Personal communications
- [x] Web history
- [x] Website content

Leave unticked: Health information, Financial and payment information, User activity. Tab events only keep the tab list current; the policy treats them as web history, not as activity monitoring.

The docs show the category labels only in a screenshot, so compare these names with the live form before ticking. This follows the FAC-307 decision: the form certifies that the answers match the privacy policy, and the policy covers the whole item (the account and the extension), so the boxes follow what the policy collects.

### Certifications

Tick all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

The sentences above are the standard Limited Use certifications; the docs give no verbatim wording, so match them to the live form. The fact behind them is the owner's: nobody at Linklog reads the page text lenses store, neither through admin tools nor through logs (owner, 2026-11-26).

### Privacy policy URL

```
https://linklog.facundopri.com/privacy
```

The policy must be live at that URL before submitting. It names the providers the UI only calls "remote AI provider" and "remote extraction service": TypeSafe or Cloudflare Workers AI for lenses, and Cloudflare Browser Run for extraction. The Connect page links to the same URL.

## Checks

### Every permission has a justification (and the reverse)

Compared on 2026-11-27 with the `manifest.json` inside `linklog-extension-0.3.0.zip`, downloaded from the GitHub release `extension-v0.3.0` (built from `34203b1`). Version 0.3.0; `permissions` = `storage`, `scripting`, `tabGroups`, `tabs`; `host_permissions` = `[]`; `optional_host_permissions` = `http://*/*`, `https://*/*`; one content script, `matches` = `https://linklog.facundopri.com/*`; CSP `script-src 'self'; object-src 'self'`; no other permission-bearing key.

| Manifest entry (0.3.0) | Justification above |
| --- | --- |
| `permissions: tabs` | `tabs` |
| `permissions: tabGroups` | `tabGroups` |
| `permissions: scripting` | `scripting` |
| `permissions: storage` | `storage` |
| `optional_host_permissions: http://*/*` | Optional host permissions |
| `optional_host_permissions: https://*/*` | Optional host permissions |
| `content_scripts[0].matches: https://linklog.facundopri.com/*` | Host access (bridge content script) |
| `host_permissions: []` | none, nothing to justify |

The long description's "Permissions" list names the same entries. Result: every manifest entry has a justification and every justification names a manifest entry.

### Long description and the Connect disclosure

Connect text: the shipped `connect.html` (consent card and "Page content" row), which supersedes the draft in [FAC-305, "The disclosure"](grills/FAC-305.md#the-disclosure-connect-page-english). Each line of the disclosure has its counterpart in "What the extension reads, and when":

| Connect disclosure | Long description |
| --- | --- |
| Reads nothing until you accept | "Nothing until you click 'Accept and connect'" |
| URL and title of every open tab, in every window, and your tab groups | "the URL and title of every open tab, in every Chrome window, and your tab groups" |
| Sends the tabs of Linklog's window to the Linklog page | "The tabs of Linklog's window are shown to your Linklog page." |
| Page text and preview only if page content is allowed | "Page text and previews only if you also click 'Allow page content'" |
| Lens evaluation or auto-grouping: URL, title and text go to your library, whose server sends them to a remote AI provider; auto-grouping also sends the group names and descriptions | "Page text leaves your browser only when a lens ... evaluates a tab, or when you auto-group tabs. Then the tab's URL, title and text go to your Linklog library, whose server sends them to a remote AI provider ... Auto-grouping also sends the names and descriptions of the groups you chose." |
| Reload (Load content) and sleep only when you ask | "Linklog reloads a tab ... or puts it to sleep only when you ask." |
| Group name, color and description, and the library that linked them, stay on the device | "The name, color and description of groups you link to Linklog, and which Linklog library linked them, stay on your device" |
| Saving sends only the URL; remote extraction service | "Saving a tab sends only its URL. Linklog then fetches the page with a remote extraction service" |
| Never cookies, passwords or form fields; not sold; providers named in the policy | same sentence |

The group-storage line is also covered by the `tabGroups` and `storage` justifications. The Connect "Page content" row says the same as the optional-host justification about reloading, sleeping and page text.

### Short description

The listing's short description is the manifest `description` (FAC-306 decision 6): `Review, group and save your open Chrome tabs in Linklog. It reads tab URLs and titles only after you accept.` It has 108 characters (measured) and is byte-equal to the `description` in the 0.3.0 ZIP's manifest (compared on 2026-11-27).

### Every ticked box maps to a policy section

Section names are those of the draft policy in [FAC-307, "Draft policy"](grills/FAC-307.md#draft-policy), published at `/privacy`.

| Box | Ticked because | Policy section |
| --- | --- | --- |
| Personally identifiable information | Account email and name | "Your account" |
| Authentication information | Password hash, sign-in links, sessions | "Your account"; "Sign-in sessions" |
| Location | IP address recorded with each session | "Sign-in sessions" |
| Personal communications | Saved social media posts and their text; open pages such as webmail, when a lens evaluates them | "Your library"; "Data from the extension" |
| Web history | Tab URLs and titles | "Data from the extension" |
| Website content | Page text, description and images | "Data from the extension" |
| Health, Financial and payment, User activity | Not collected | none |
| Certifications (three) | No sale, no unrelated use, no credit use | "Where data goes"; "Chrome Web Store Limited Use" |
| Remote code: No | Extraction is bundled | none |

## Pending

1. **Owner approval of this copy**, as a comment on FAC-310. Not given.
2. **Labels in the live form.** The data-usage categories and the certification sentences are written from the dashboard's documented behavior; the docs show them only in screenshots.
3. **`/privacy` is not live yet.** On 2026-11-27 `https://linklog.facundopri.com/privacy` still returns the app's own page (FAC-307, PR #59, is open). Submit only after `curl -s https://linklog.facundopri.com/privacy | grep '<title>'` shows the policy title.
4. **Policy wording.** The policy draft says the extension reads tabs "in the Chrome window where Linklog is open", while the extension reads every window (Connect, the single purpose and this listing say so). The policy needs the same fix (FAC-412). The shipped Connect page has the same split: its consent card says "every Chrome window" and its permissions card says "the tabs and groups of the window where Linklog is open".
5. **What the docs don't say.** [The listing page](https://developer.chrome.com/docs/webstore/cws-dashboard-listing?hl=en) doesn't state which fields come from the manifest, nor give a character limit for any field. [The privacy page](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy?hl=en) doesn't give limits either, and lists no host-permission field. The 108-character short description and the FAC-306 statement that the store takes it from the manifest rest on the research doc, not on those pages.
