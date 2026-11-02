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
src/components/              one file per section; AutoTags, Lenses and BrowserDemo are panels
                             inside Showcase; Icon.astro inlines Phosphor SVGs at build time
src/scripts/                 demo logic: hero.ts, autotags.ts, lenses.ts, browser.ts
src/scripts/motion.ts        shared helpers: reduced motion, in view, FLIP transitions
src/data/                    sample library, FAQ copy, URLs
src/styles/global.css        tokens copied from src/index.css, named text styles, motion
public/og.png                1200x630 social image
```

The colors are the app's: the neutral ramp at hue 260, the green brand
`oklch(0.52 0.12 160)` and the eight tag hues. Change them in `global.css`.

## Page outline

Short copy, motion carries the explanation.

1. **Hero.** "Your links and tabs, sorted the way you think." One CTA, three proof points and an
   animated app window: a pasted list becomes rows that fetch a preview, read the page and get
   tagged. On wide screens three floating cards show an auto tag, a lens and Autogroup.
2. **Sources.** A marquee of what Linklog reads (web pages, YouTube captions, X and Instagram
   posts, text in images, open tabs).
3. **Features.** A bento grid; each card has a looping animation and one line of copy. Loops pause
   off screen.
4. **Live demo.** Tabs for the three interactive demos: auto tags with a threshold slider, lenses
   with answer filters, and a Chrome window where Autogroup files tabs and saved tabs close.
5. **Tagline reveal.** "Describe it once. Linklog keeps it in order." lights up word by word.
6. **FAQ.** Six short answers, also published as FAQPage structured data.
7. **Final CTA.** "Log it once. Find it whenever you need it."

The marquee is the one animation on a linear curve, because a ticker must move at constant speed.

## Content rules

Every claim on the page comes from the repository README or the Browser docs. There are no
testimonials, customer counts or prices because none exist yet; add them only from real sources.
The sample links in the demos are fictional pages on real kinds of sites.

Not shipped yet: privacy policy and terms pages (the footer links to the GitHub repository and its
issues instead) and cookie consent (the page sets no cookies and loads no third party scripts).
