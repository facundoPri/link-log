# Linklog

Linklog saves the links a user collects, extracts what each one says, and organizes them in the user's library.

## Library

**Library**:
Everything one user has saved: links, tags, lenses and results, and the 30 newest batches. It lists only those 30 batches, so a client waiting for a batch must settle without it once the batch is no longer listed.
_Avoid_: Collection, workspace

**Link**:
A URL saved once in one user's library, with its preview and content.
_Avoid_: Bookmark, entry, item

**Preview**:
The title, description, image and favicon read from a link's page.
_Avoid_: Metadata

**Content**:
The full text of a link, as markdown, that tags and lenses evaluate.
_Avoid_: Body, scrape

**Extraction**:
Fetching a link's preview and then its content.
_Avoid_: Processing, scraping

**Duplicate**:
A URL submitted again for a link the user already has. It refreshes the link's recency and is never extracted or charged again.
_Avoid_: Re-upload, resubmission

## Work

**Batch**:
One action a user starts over a set of links, such as applying a lens to 240 links. It is made of jobs.
_Avoid_: Run, queue batch

**Job**:
One batch's action on one link. A link runs one job at a time.
_Avoid_: Task, request

## Programmatic access

**API key**:
A named, user-owned secret that only submits URLs to that user's library. It cannot read the library.
_Avoid_: Token, API token, credential

**Revoked API key**:
An API key that no longer authenticates but stays listed, and can be enabled again or deleted.
_Avoid_: Disabled key

**Deleted API key**:
An API key removed for good. Its Links stay, and Usage keeps counting them under the name of the key's newest submission, marked as deleted.
_Avoid_: Revoked key

**Slack connection**:
One Slack identity (a workspace and a Slack user in it) linked to one Linklog user by adding the Linklog Slack app, with the channels whose messages count. A message lands only in the library of its author's Slack connection.
_Avoid_: Slack integration, Slack account, installation

## Browser

**Sleeping tab**:
An open browser tab whose page Linklog cannot read until Chrome loads or wakes it again. The reason is a detail, not a separate concept: unloaded to save memory or restored but never loaded (the page is not in memory), or frozen (the page is in memory but its tasks are suspended).
_Avoid_: Hibernated tab, discarded tab, unloaded tab

**Consent**:
The user's **Accept and connect** on the extension's Connect page, after its disclosure. Until then the extension reads no tab, URL, title or group, and Linklog's Browser view shows "Not connected yet" (ADR 0005). Granting page content is a separate, later step.
_Avoid_: Opt-in, permission (Chrome's permissions are a different thing)
