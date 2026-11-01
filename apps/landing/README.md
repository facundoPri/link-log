# Linklog landing page

Static marketing site for Linklog, built with Astro 7 and Tailwind v4. It ships plain HTML,
one stylesheet and a few small scripts for the demos; no framework runtime.

```sh
bun run landing:dev       # http://localhost:4321
bun run landing:build     # static output in apps/landing/dist
bun run landing:preview   # serve the build
```

| Variable         | Default                          | Use                                    |
| ---------------- | -------------------------------- | -------------------------------------- |
| `PUBLIC_APP_URL` | `https://linklog.facundopri.com` | Target of every "Start your library"   |
| `LANDING_SITE`   | `https://linklog.facundopri.com` | Canonical URL, `og:url` and `og:image` |

`dist/` is a static folder: it can go on Cloudflare Pages or Workers Static Assets as is. It is not
wired into the app's `wrangler.jsonc`, so deploying the app never touches it.

## Layout

```text
src/pages/index.astro        sections in order, JSON-LD (SoftwareApplication + FAQPage)
src/pages/404.astro          branded not found page
src/layouts/Base.astro       head, meta and social tags, skip link, nav, footer
src/components/              one file per section; Icon.astro inlines Phosphor SVGs at build time
src/scripts/                 demo logic: hero.ts, autotags.ts, lenses.ts, browser.ts
src/scripts/motion.ts        shared helpers: reduced motion, in view, FLIP transitions
src/data/                    sample library, FAQ copy, URLs
src/styles/global.css        tokens copied from src/index.css, named text styles, motion
public/og.png                1200x630 social image
```

The colors are the app's: the neutral ramp at hue 260, the green brand
`oklch(0.52 0.12 160)` and the eight tag hues. Change them in `global.css`.

## Page outline

1. **Hero.** "Your links and tabs, sorted the way you think." One CTA (Start your library),
   three true proof points (private per account, Chrome extension, open source) and an animated
   app window: a pasted list becomes rows that fetch a preview, read the page and receive tags
   with their confidence.
2. **How it works.** Save it your way, describe your criteria, find it and act on it.
3. **Auto tags (interactive).** Tag rules written as sentences, three sample links, a score bar per
   tag and a threshold slider that moves tags between Applied and Kept as scores only.
4. **Lenses (interactive).** Three lenses (yes or no, and two choices). Answers arrive per row;
   filters by answer use FLIP transitions; a lens already run renders from saved results.
5. **Tagline reveal.** Two lines whose words light up one by one while scrolling.
6. **Browser (interactive).** A Chrome window with twelve loose tabs: Autogroup suggests a group
   per tab, Apply builds Chrome tab groups, Close saved closes the tabs marked Saved. Plays once by
   itself, and any click hands control to the visitor.
7. **Details.** Six concrete benefits taken from the README.
8. **FAQ.** Eight questions, also published as FAQPage structured data.
9. **Final CTA.** "Log it once. Find it whenever you need it."

Layout type: classic hero plus sections, because the product is easiest to understand by seeing
it work. Index the page: it is an evergreen description of the product.

## Content rules

Every claim on the page comes from the repository README or the Browser docs. There are no
testimonials, customer counts or prices because none exist yet; add them only from real sources.
The sample links in the demos are fictional pages on real kinds of sites.

Not shipped yet: privacy policy and terms pages (the footer links to the GitHub repository and its
issues instead) and cookie consent (the page sets no cookies and loads no third party scripts).
