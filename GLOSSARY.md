# Linklog

Linklog saves the links a user collects, extracts what each one says, and organizes them in the user's library.

## Library

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
