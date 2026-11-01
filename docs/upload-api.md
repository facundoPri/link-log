# Upload API

`POST /api/v1/links` sends URLs into your Linklog library from a script, a server or a phone shortcut. It accepts URLs only, as plain strings or as text that contains URLs. It cannot read your library.

The examples use `$LINKLOG_URL` (your Linklog origin, for example `https://linklog.facundopri.com`) and `$LINKLOG_KEY` (an API key secret). `scripts/check-upload-api-docs.ts` runs every example below against a local instance and compares the output with the response shown.

## Authentication

Create an API key in Settings. Linklog shows the secret once, next to a ready `curl` example, and never again. Keys always start with `lk_` (a prefix secret scanners recognize; it cannot be changed), never expire, and work until you revoke or delete them. You can have as many keys as you like, and names can repeat.

### Managing keys

Settings lists your active keys, each with Revoke and Delete. A revoked key stops working at once and moves to a collapsed Revoked keys section, where you can Enable it again or Delete it. Deleting asks for confirmation and removes the key for good. To replace a key, create a new one and revoke or delete the old one.

Settings uses the routes of Better Auth's API key plugin, under `/api/auth/api-key`: `create`, `get`, `list`, `update` and `delete`. They need your signed-in browser session and the app's own origin, so an API key cannot call them. The plugin's server-only fields (limits, refill, permissions, expiration) cannot be set from the browser, and neither can `prefix` or `configId`: a create that sends either answers `400` with code `SERVER_ONLY_PROPERTY`.

Creating, renaming, revoking, enabling and deleting a key each count as one write against the account's writes budget (120 per minute, see 429 and Retry-After), the same budget the web app and every API key share. When it is spent these routes answer `429` with a `Retry-After` header, in Better Auth's error shape: `{ "message": "Too many requests. Try again later.", "code": "writes" }`. Listing and reading keys are free.

Links a deleted key already added stay in your library. Settings > Usage keeps counting them under the name of the key's most recent submission, marked as deleted. While a key exists, Usage shows its current name, so a rename shows at once.

Send the API key secret in the `Authorization` header, after `Bearer`:

```
Authorization: Bearer lk_…
```

An API key can do one thing: submit URLs to the library of the user who owns it. The owner always comes from the key, never from the request. A key cannot read the library, Activity or any other route, and it cannot create or manage keys. Cookies are ignored on `/api/v1`.

There are no webhooks and no result delivery. The `202` response is the only answer you get. Follow what happens next in Activity, where a submission shows as `Extract context · API · <key name>` and can be cancelled like any web upload.

The endpoint sends no CORS headers, so browsers on other sites cannot call it. Do not put a key in front-end code.

## Request

`POST /api/v1/links` with a JSON object body:

```json
{ "urls": ["https://example.com/a", "Read this: https://example.com/b."] }
```

| Field | Type | Rules |
| --- | --- | --- |
| `urls` | array of strings | 1 to 1000 strings, each at most 8192 characters. Each string can be a bare URL or any text. |

The whole body can be at most 2.1 MB. The `Content-Type` header is not checked, but send `application/json`.

### How URLs are extracted

Linklog scans every string for `http` and `https` URLs, then saves each URL through the same rules as a Link added in the web app: the same normalization (tracking parameters removed, scheme added), and the same Extraction (Preview, then Content).

- A URL starts at `http://` or `https://` (any letter case) and ends at whitespace or at one of `< > " [ ] \``. Markdown links such as `[page](https://example.com)` and `<https://example.com>` work.
- Trailing `. , ; : ! ? ' * _` are removed. A trailing `)` is removed only when it has no matching `(` in the URL, so `https://en.wikipedia.org/wiki/Rust_(programming_language)` stays whole.
- Other schemes (`ftp:`, `mailto:`, `javascript:`) are ignored. URLs with credentials or a host without a dot are not valid and are dropped.
- If a string has no `http` or `https` URL and is a single token with no whitespace, Linklog treats it as a bare URL and adds `https://`, as the web app does: `example.com` and `example.com/page` are saved as `https://example.com/` and `https://example.com/page`. The host needs a dot, so `localhost` is not a link.
- One string can hold several URLs. Each becomes its own result, and all of them report that string as `input`.
- A URL that appears more than once in the request is saved once. The first string that contains it is its `input`. Every occurrence still counts toward the 1000 URL candidates per request (see Limits).
- A string with no valid URL is reported in `rejected` and is never stored. If it held an `http` or `https` URL that broke a rule above, the `error` is that rule's message (for example `Use a public http or https link.`). Otherwise it is `No valid http or https link found.`

### Duplicates

A URL you already have is a Duplicate. Linklog refreshes the Link's recency, does not extract it again and does not charge it against your links quota. It appears in `results` with `"status": "duplicate"`.

One exception, the same as in the web app: a Link that was saved but never got an Extraction job and has no Content (left behind by an interrupted save) is queued for Extraction when you send its URL again. It still reports `"status": "duplicate"`, but the response carries the `batchId` of that Extraction, and it is not charged against your links quota (it is not a new Link).

## Response

### 202 Accepted

At least one valid URL was found. Valid URLs are saved even when other strings are rejected.

| Field | Meaning |
| --- | --- |
| `results` | One entry per distinct URL, in order of appearance. |
| `results[].input` | The string the URL came from. |
| `results[].url` | The normalized URL Linklog saved. |
| `results[].id` | The Link id. |
| `results[].status` | `"created"` for a new Link, `"duplicate"` for a Duplicate. |
| `rejected` | Strings that were not accepted, as `{ "input", "error" }`. Empty when everything was accepted. |
| `batchId` | The Activity batch that holds the Links queued for Extraction. Absent when nothing was queued. |

`202` means the Links are saved and Extraction is queued, not finished.

### Errors

Every error body is JSON with an `error` message. Some also carry `code` or `rejected`.

| Status | When | Body |
| --- | --- | --- |
| 400 | `urls` is missing, not an array, empty, longer than 1000, or holds a non-string. | `{ "error": "Send `urls`: 1 to 1000 strings." }` |
| 400 | A string in `urls` is longer than 8192 characters. Nothing is saved. | `{ "error": "Each string can be at most 8192 characters." }` |
| 400 | The body is not valid JSON. The message adds the position of the broken character when the parser gives one. | `{ "error": "Body is not valid JSON (at position 11)." }` |
| 400 | The body is valid JSON but not an object. | `{ "error": "Send a JSON object as the body." }` |
| 400 | No valid URL in the whole request. | `{ "error": "No valid http or https link found.", "rejected": [...] }` |
| 400 | More than 100 distinct URLs after extraction. Nothing is saved. | `{ "error": "Send at most 100 links per request." }` |
| 400 | More than 1000 URL candidates in the request, counting every occurrence and every invalid one. Nothing is saved. | `{ "error": "Send at most 1000 URL candidates per request, repeats and invalid ones included." }` |
| 401 | The key is missing, malformed, unknown or revoked. | `{ "error": "A valid API key is required." }` |
| 404 | With a valid key, any path under `/api/v1` other than `/api/v1/links`, or a method other than `POST`. Without a valid key, those requests are `401`. | `{ "error": "Not found." }` |
| 413 | The body is larger than 2.1 MB. | `{ "error": "Request too large." }` |
| 429 | A quota ran out. Nothing is saved. | `{ "error": "…", "code": "writes" \| "links" }` and a `Retry-After` header |
| 503 | Linklog could not check the key. Retry. | `{ "error": "Could not check the API key. Try again." }` |

A `rejected` entry that comes back with a `202` carries the message of the URL rule the string broke (for example `"Use a public http or https link."`), `"No valid http or https link found."` or `"Could not save the link."`.

### 429 and Retry-After

A `429` carries `Retry-After`, the seconds until the quota window resets (at least 1), and a `code` that names the quota that ran out:

| `code` | Quota | Message |
| --- | --- | --- |
| `writes` | 120 write requests per minute for your account, shared by the web app, every API key and the key routes in Settings (create, update, delete). Every request with a valid key counts, including ones that end in `400`. | `Too many requests. Try again later.` |
| `links` | 500 new Links per hour for your account, shared with the web app. This is the only cap on what you can upload: extracting a Link, running a lens or auto-tag on it and retrying are not limited separately. | `Link limit reached. Try again later.` |

Windows are fixed, not sliding: `Retry-After` is the time to the end of the current minute or hour window. Duplicates are not charged against `links`. A `429` saves nothing from that request. The quotas belong to your account, not to a key: revoking or deleting a key never gives any of them back.

## Limits

| Limit | Value |
| --- | --- |
| URLs per request, after extraction | 100 |
| URL candidates per request (text starting with `http://` or `https://`, or a bare token), repeats and invalid ones included | 1000 |
| Strings in `urls` | 1000 |
| Length of one string | 8192 characters |
| Request body | 2.1 MB |
| Write requests per account | 120 per minute (web, API and key management together) |
| New Links per account | 500 per hour (web and API together) |

Only new Links are capped. Settings > Usage shows the hour's count and, for the month, how many new Links the web and each key created (each Link counts once, under what created it: a Link the web saved stays the web's even if a key later sends its URL again), and what the work cost per feature (extract, content, lenses, auto-tag, OCR, autogroup) as runs, tokens or browser time, and an estimated cost; none of those are limits.

## Examples

Each example is followed by the response it returns. The examples run in order, because the second one depends on the first.

### Submit text with several URLs

<!-- example: created -->
```sh
curl -s -X POST "$LINKLOG_URL/api/v1/links" \
  -H "Authorization: Bearer $LINKLOG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls":["Read this: [page](https://example.com/a) and <https://example.com/b>.","not a link"]}'
```

Response `202`:

```json
{
  "results": [
    { "input": "Read this: [page](https://example.com/a) and <https://example.com/b>.", "url": "https://example.com/a", "id": "<id>", "status": "created" },
    { "input": "Read this: [page](https://example.com/a) and <https://example.com/b>.", "url": "https://example.com/b", "id": "<id>", "status": "created" }
  ],
  "rejected": [{ "input": "not a link", "error": "No valid http or https link found." }],
  "batchId": "<id>"
}
```

### Send a Duplicate

<!-- example: duplicate -->
```sh
curl -s -X POST "$LINKLOG_URL/api/v1/links" \
  -H "Authorization: Bearer $LINKLOG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com/a"]}'
```

Response `202`. There is no `batchId`, because nothing new was queued:

```json
{
  "results": [{ "input": "https://example.com/a", "url": "https://example.com/a", "id": "<id>", "status": "duplicate" }],
  "rejected": []
}
```

### No valid URL

<!-- example: no-url -->
```sh
curl -s -X POST "$LINKLOG_URL/api/v1/links" \
  -H "Authorization: Bearer $LINKLOG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls":["nothing here","ftp://files.example/x"]}'
```

Response `400`:

```json
{
  "error": "No valid http or https link found.",
  "rejected": [
    { "input": "nothing here", "error": "No valid http or https link found." },
    { "input": "ftp://files.example/x", "error": "No valid http or https link found." }
  ]
}
```

### Bad request shape

<!-- example: bad-shape -->
```sh
curl -s -X POST "$LINKLOG_URL/api/v1/links" \
  -H "Authorization: Bearer $LINKLOG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls":[]}'
```

Response `400`:

```json
{ "error": "Send `urls`: 1 to 1000 strings." }
```

### Body is not valid JSON

A shell can alter a quoted body. zsh's `url-quote-magic` turns `?` and `=` inside a pasted URL into `\?` and `\=`, which JSON does not allow. The error says so:

<!-- example: bad-json -->
```sh
curl -s -X POST "$LINKLOG_URL/api/v1/links" \
  -H "Authorization: Bearer $LINKLOG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls":["\?"]}'
```

Response `400`:

```json
{ "error": "Body is not valid JSON (at position 11)." }
```

### More than 100 URLs

<!-- example: too-many -->
```sh
urls=$(seq 1 101 | sed 's|.*|"https://example.com/many-&"|' | paste -sd, -)
curl -s -X POST "$LINKLOG_URL/api/v1/links" \
  -H "Authorization: Bearer $LINKLOG_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"urls\":[$urls]}"
```

Response `400`. Nothing is saved:

```json
{ "error": "Send at most 100 links per request." }
```

### Missing or revoked key

<!-- example: unauthorized -->
```sh
curl -s -X POST "$LINKLOG_URL/api/v1/links" \
  -H "Authorization: Bearer lk_not_a_real_key" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com/a"]}'
```

Response `401`:

```json
{ "error": "A valid API key is required." }
```

### Write limit reached

After 120 write requests in one minute (from the web app and your keys together), `-i` shows the headers:

<!-- example: rate-limited -->
```sh
curl -si -X POST "$LINKLOG_URL/api/v1/links" \
  -H "Authorization: Bearer $LINKLOG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com/a"]}'
```

Response `429`. `Retry-After` is the seconds until the next minute starts:

```
Retry-After: 23
{"error":"Too many requests. Try again later.","code":"writes"}
```
