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
| Distribution regions | All regions except the European Economic Area, the United Kingdom and Switzerland (the policy says the beta is not offered there; FAC-307 owner answer 3) |
| Mature content | Off |
| Store icon | 128×128, from the packaged build (`icons/128.png`, FAC-306) |
| Promo tiles, video | None for the Unlisted submission |
| Screenshots | 1 to 5 at 1280×800. Taken in Part 2, from the packaged 0.3.0 build. See [Screenshots](#screenshots) |

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
• Page text leaves your browser only when a lens you turned on evaluates a tab. Its URL and text go to your Linklog library, whose server sends them to a remote AI provider for the answer.
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

Differences from the accepted draft, so the text says what the Connect disclosure says (acceptance criterion 3):

- "of every open tab, in every Chrome window" (the draft said "your open tabs"; the Connect text names every window).
- "Its URL and text go to your Linklog library, whose server sends them to a remote AI provider for the answer" (the draft said the text "goes to your Linklog library, which uses a remote AI provider").
- "The providers we use are named in the privacy policy" (a sentence of the Connect text that the draft left out).

### Screenshots

1280×800, 1 to 5, from the packaged 0.3.0 build against production, with a demo account and neutral tabs (no fixtures, no test profiles). Planned set:

1. Browser view with the tab list and previews.
2. A lens sorting the tabs (Yes / Unsure / No).
3. Grouping selected tabs.
4. The Connect page consent card.
5. Optional: Browser view's "Not connected yet" state.

Part 2 adds the files under `docs/store/`. None yet.

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
Browser view lists the user's open tabs so they can review them. The extension needs "tabs" to read each tab's URL, title and icon, and to group, move, open, put to sleep and close the tabs the user selects. Nothing is read until the user accepts the disclosure on the extension's Connect page. Tab URLs and titles are shown to the user's Linklog page. They leave the browser only when the user turns on a lens or saves a tab: then the URL goes to the user's Linklog library, and for lenses so does the page text.
```

**`tabGroups`**

```
To show the user's tab groups in Browser view, and to create, rename, recolor, move and ungroup them when the user groups tabs from Linklog. The title, color and description of a group the user links to Linklog are kept in local storage, so the link survives a Chrome restart.
```

**`scripting`**

```
To run the extractor bundled in the package (extract.js, no remote code) in open tabs where the user granted page access, and read the title, description, preview image and page text for previews and lenses. It never runs on pages without a user-granted host permission.
```

**`storage`**

```
chrome.storage.session holds the open-tab registry, lens results per tab and the load queue, cleared when Chrome closes. chrome.storage.local holds the user's consent, an installation id, the look of linked tab groups and the chosen load concurrency.
```

**Optional host permissions `http://*/*` and `https://*/*`**

```
Browser view reviews whatever tabs the user has open, on any site, so the sites can't be listed in advance. Access is requested only when the user clicks "Allow page content" on the Connect page, after the disclosure, and can be removed there at any time. Chrome's Site access can also limit it to specific sites, and the extension honors that per tab. It is used only to run the bundled extractor in the tabs the user reviews: no cookies, no form fields, no history, no clicking, no scrolling, and the extractor changes nothing on the page. The one time the extension reloads a page is when the user asks to load a tab Chrome has put to sleep; it puts the tab back to sleep afterwards. Page text leaves the browser only when a lens the user turned on evaluates a tab.
```

**Host access `https://linklog.facundopri.com/*` (bridge content script)**

```
Connects the Linklog web app to the extension. The script stays inert unless the page identifies as Linklog, and only relays validated messages between that page and the extension.
```

The optional-host text differs from the accepted draft in one clause. The draft said "no page changes, no reloading or scrolling". The code reloads a sleeping tab when the user asks to load its content (`chrome.tabs.reload` in `apps/extension/src/background/loader.ts`), and the privacy policy says so. A reviewer reading "no reloading" next to the policy would see a contradiction, so the text now says what happens. The Connect page still says "pages are never reloaded or scrolled"; see [Pending](#pending).

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

Target manifest: [FAC-306](grills/FAC-306.md), built with `LINKLOG_ORIGINS=https://linklog.facundopri.com bun run extension:package`. The builder today (`apps/extension/scripts/build.ts`) already declares the same four permissions and the same optional hosts. The packaged build differs in the bridge matches and the description only.

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

The long description's "Permissions" list names the same entries. Part 2 repeats this comparison against the `manifest.json` inside the real ZIP. Status: **not yet compared against the shipped ZIP.**

### Long description and the Connect disclosure

Connect text: [FAC-305, "The disclosure"](grills/FAC-305.md#the-disclosure-connect-page-english). Each line of the disclosure has its counterpart in "What the extension reads, and when":

| Connect disclosure | Long description |
| --- | --- |
| Reads nothing until you accept | "Nothing until you click 'Accept and connect'" |
| URL and title of every open tab, in every window, and your tab groups | "the URL and title of every open tab, in every Chrome window, and your tab groups" |
| Sends the tabs of Linklog's window to the Linklog page | "The tabs of Linklog's window are shown to your Linklog page." |
| Page text and preview only if page content is allowed | "Page text and previews only if you also click 'Allow page content'" |
| Lens: URL and text go to your library, whose server sends them to a remote AI provider | "Page text leaves your browser only when a lens ... evaluates a tab. Its URL and text go to your Linklog library, whose server sends them to a remote AI provider" |
| Saving sends only the URL; remote extraction service | "Saving a tab sends only its URL. Linklog then fetches the page with a remote extraction service" |
| Never cookies, passwords or form fields; not sold; providers named in the policy | same sentence |

The Connect line "The name and color of groups you link to Linklog stay on this device" is covered by the `tabGroups` and `storage` justifications, not by the long description. The Connect page the extension ships is FAC-305's; Part 2 re-reads it in the build.

### Short description

The listing's short description is the manifest `description` (FAC-306 decision 6): `Review, group and save your open Chrome tabs in Linklog. It reads tab URLs and titles only after you accept.` It has 108 characters (measured). The manifest in `main` still carries the 0.2.1 text until the FAC-305/306 PR merges.

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
2. **Part 2:** compare the justifications with the `manifest.json` of the real 0.3.0 ZIP, and add the screenshots.
3. **Labels in the live form.** The data-usage categories and the certification sentences are written from the dashboard's documented behavior; the docs show them only in screenshots.
4. **`/privacy` is not live yet.** On 2026-11-27 `https://linklog.facundopri.com/privacy` still returns the app's own page (FAC-307 ships the policy). Submit only after `curl -s https://linklog.facundopri.com/privacy | grep '<title>'` shows the policy title.
5. **Wording gaps in the extension and the policy, outside this ticket's files:**
   - The Connect page says pages are "never reloaded", but the loader reloads sleeping tabs on request, and the policy says so. This listing says what the code does.
   - The policy says auto-grouping also sends page text to Linklog, as lenses do; the Connect disclosure and this long description mention lenses only.
6. **What the docs don't say.** [The listing page](https://developer.chrome.com/docs/webstore/cws-dashboard-listing?hl=en) doesn't state which fields come from the manifest, nor give a character limit for any field. [The privacy page](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy?hl=en) doesn't give limits either, and lists no host-permission field. The 108-character short description and the FAC-306 statement that the store takes it from the manifest rest on the research doc, not on those pages.
