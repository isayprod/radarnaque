# Design System

One visual language for every surface of the product: landing page, browser extension (popup, in-page UI, options page) and admin dashboard. Read this file fully before building or changing any UI.

---

## 0. How to use this document

- **Foundations (section 2)** and **Components (section 3)** apply everywhere. Never redefine a token locally; add it here first.
- **Surfaces (section 4)** describe how the language adapts to each context. A popup is not a small landing page, and a dashboard is not a big popup.
- When something is not covered, extend the closest existing pattern instead of inventing a new one, then document the addition here.
- Verify every screen visually before calling it done (section 5).

### Reference (landing page language only)

Study these for hierarchy, rhythm, spacing and colour. Do not copy content, branding or layout literally.

- Full page: https://kage-design-assets.t3.tigrisfiles.io/screenshots/umbra-mail/e5ad193a-88e6-403f-9829-5608575fa4bb-1792476206048-full.webp
- Above the fold: https://kage-design-assets.t3.tigrisfiles.io/screenshots/umbra-mail/e5ad193a-88e6-403f-9829-5608575fa4bb-1792476204372.webp
- Design on Kage: https://kage.design/designs/umbra-mail-landing-page

---

## 1. Before you start

If any of these are unknown, ask the user and wait for answers before designing:

1. Product name, one-line value proposition, and who it is for.
2. Existing brand assets: logo, colours, typefaces. Brand values override the defaults in section 2, but keep the structure (roles, scale, contrast rules).
3. What the extension does on a page (reads the current tab? injects UI? needs login?).
4. What the admin manages (users, items, reports, settings) and the 3 to 5 numbers an admin checks first.
5. Target browsers (Chrome only, or Chromium + Firefox).

Use the product's own content everywhere. Never ship placeholder lorem ipsum.

---

## 2. Foundations

### 2.1 Principles

1. **Calm over busy.** Sparse composition, generous negative space, few elements per view.
2. **Editorial hierarchy.** A dramatic serif for display moments, a neutral sans for everything functional.
3. **Density only where data lives.** Chrome (nav, headers, footers) stays quiet; lists, tables and previews may be dense.
4. **One atmospheric moment per surface.** The gradient is a signature, not a wallpaper.
5. **Slow, quiet motion.** Subtle lifts and fades. Nothing bouncy.

### 2.2 Colour tokens

Define as CSS custom properties in one shared file consumed by all surfaces (landing, extension, admin).

```css
:root {
  /* Signature gradient stops (atmosphere only) */
  --grad-1: #0649b8; /* cobalt */
  --grad-2: #4e8fe8; /* sky blue */
  --grad-3: #c7b9ec; /* lilac */
  --grad-4: #ffd4ad; /* warm peach */
  --grad-5: #e16c3f; /* horizon orange */
  --gradient-hero: linear-gradient(
    180deg,
    var(--grad-1) 0%,
    var(--grad-2) 28%,
    var(--grad-3) 55%,
    var(--grad-4) 80%,
    var(--grad-5) 100%
  );
  --gradient-compact: linear-gradient(
    160deg,
    var(--grad-1) 0%,
    var(--grad-2) 60%,
    var(--grad-3) 100%
  ); /* small areas: popup header, login */
  --gradient-hairline: linear-gradient(
    90deg,
    var(--grad-2),
    var(--grad-3),
    var(--grad-4)
  ); /* 1-2px accent lines */

  /* Ground (navy, from deepest to raised) */
  --bg-0: #020b2d; /* page / app background */
  --bg-1: #031033; /* section background, sidebar */
  --bg-2: #08174a; /* raised panel */
  --bg-3: #0d2160; /* hover / selected row */

  /* Glass (translucent surfaces over gradient or navy) */
  --glass-bg: rgba(8, 23, 74, 0.62);
  --glass-bg-strong: rgba(3, 16, 51, 0.82);
  --glass-blur: 18px;

  /* Lines */
  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-default: rgba(255, 255, 255, 0.1);
  --border-strong: rgba(255, 255, 255, 0.18);

  /* Text */
  --text-1: #ffffff; /* headings, primary values */
  --text-2: rgba(226, 232, 255, 0.74); /* body, labels */
  --text-3: rgba(200, 210, 240, 0.52); /* metadata, timestamps, placeholders */
  --text-on-light: #020b2d; /* text on white pills */

  /* Interaction */
  --accent: #4e8fe8; /* active nav, focus, selected */
  --accent-soft: rgba(78, 143, 232, 0.16);
  --focus-ring: 0 0 0 2px var(--bg-0), 0 0 0 4px var(--accent);

  /* Semantic (harmonised with the gradient) */
  --success: #5fd3a5;
  --success-soft: rgba(95, 211, 165, 0.14);
  --warning: #ffb877;
  --warning-soft: rgba(255, 184, 119, 0.14);
  --danger: #ff6b6b;
  --danger-soft: rgba(255, 107, 107, 0.14);
  --info: #4e8fe8;
  --info-soft: rgba(78, 143, 232, 0.14);

  /* Data visualisation (ordered, use in sequence) */
  --chart-1: #4e8fe8;
  --chart-2: #c7b9ec;
  --chart-3: #ffd4ad;
  --chart-4: #e16c3f;
  --chart-5: #5fd3a5;
  --chart-grid: rgba(255, 255, 255, 0.06);
}
```

Rules:

- The default theme is dark navy. A light theme may be added later for the admin only; if so, it must be a full token remap, never per-component overrides.
- Semantic colours are for status only (badges, scores, alerts). Never use them decoratively.
- Never put status meaning in colour alone: always pair with a label or icon.
- `--text-3` only for text 12px and above, and never for anything the user must read to act.

### 2.3 Typography

| Role            | Family                                                                                            | Use                                                          |
| --------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Display         | High-contrast editorial serif (default: **Instrument Serif**; alternatives: Fraunces, Newsreader) | Hero, section headings, page titles, KPI values, popup title |
| UI              | Neutral sans (default: **Inter**; alternative: Geist)                                             | Everything else: body, labels, buttons, tables, metadata     |
| Mono (optional) | JetBrains Mono / Geist Mono                                                                       | IDs, hashes, code, API keys (masked)                         |

Scale:

| Token        | Size / line-height                           | Family | Weight  | Where                              |
| ------------ | -------------------------------------------- | ------ | ------- | ---------------------------------- |
| `display-xl` | clamp(48px, 8vw, 104px) / 1.0                | Serif  | 400     | Landing hero                       |
| `display-l`  | clamp(36px, 5vw, 64px) / 1.05                | Serif  | 400     | Landing section headings           |
| `display-m`  | 32px / 1.1                                   | Serif  | 400     | Admin page title, KPI values       |
| `display-s`  | 22px / 1.15                                  | Serif  | 400     | Popup title, empty-state title     |
| `text-l`     | 16px / 1.5                                   | Sans   | 400     | Landing tagline, long body         |
| `text-m`     | 14px / 1.5                                   | Sans   | 400     | Default UI body                    |
| `text-s`     | 13px / 1.45                                  | Sans   | 400/500 | Table cells, list rows, popup body |
| `text-xs`    | 12px / 1.4                                   | Sans   | 400/500 | Metadata, timestamps, helper text  |
| `label`      | 11px / 1.3, uppercase, letter-spacing 0.06em | Sans   | 500     | Section labels, table headers      |

Rules:

- Serif never goes below 20px and is never bold. Sans carries all weight changes (400 / 500 / 600 only).
- Headings: letter-spacing -0.01em to -0.02em. Body: 0. Labels: +0.06em.
- Body line length 45 to 70 characters on marketing surfaces.
- Numbers in tables, KPIs and timestamps use `font-variant-numeric: tabular-nums`.
- Self-host fonts (WOFF2, subset, `font-display: swap`). The extension must bundle fonts locally, never load them from a CDN.

### 2.4 Spacing, sizing, radius

- Base unit 4px. Scale: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128`.
- Radius: `--r-xs 6px` (small controls, badges), `--r-s 10px` (inputs, rows, buttons that are not pills), `--r-m 14px` (panels, cards), `--r-l 20px` (browser mockup, modals), `--r-pill 999px` (primary CTAs, chips).
- Control heights: 28px (compact), 36px (default), 44px (landing CTA, primary popup action).
- Minimum hit target 32px in admin and popup, 44px on touch layouts.

### 2.5 Elevation, borders, glass

- Separation comes from **1px low-contrast borders and background steps**, not shadows.
- Shadows exist in three cases only:
  - Primary white pill: `0 1px 2px rgba(2,11,45,0.2), 0 6px 20px rgba(2,11,45,0.18)`
  - Floating layers (menus, popovers, toasts, drawers): `0 12px 40px rgba(0,0,0,0.45)`
  - Product mockup on the landing gradient: `0 40px 120px rgba(2,11,45,0.45)`
- Glass surfaces: `background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur)) saturate(140%); border: 1px solid var(--border-default);`. Always provide a solid fallback (`--glass-bg-strong`) when `backdrop-filter` is unsupported. Never stack glass on glass.

### 2.6 Motion

- Durations: 120ms (hover, press), 200ms (enter/exit of small elements), 320ms (drawers, modals, page sections fading in).
- Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` for enter, `cubic-bezier(0.4, 0, 1, 1)` for exit.
- Allowed: opacity fades, translateY up to 8px on enter, -1px lift on button hover, slow float (6s, 4px amplitude) on the landing mockup only.
- Forbidden: bounce, spring overshoot, scale above 1.02, parallax, spinning decorations, auto-playing carousels.
- **Exception:** the loading animation of the logo (the arc shrinks to a short stroke and grows back while the logo turns, 1.6s loop) is the only element that spins. It is allowed as a waiting indicator only, never as decoration. The status text next to it may carry a slow shimmer (2.2s, linear).
- Respect `prefers-reduced-motion: reduce`: remove translate and float, keep instant opacity changes. The loading logo stays in its resting shape (no rotation, no stroke change) and the status text shows normally (no shimmer).
- Keyframes live in the shared `motion.css` of `@radarnaque/design`.

### 2.7 Iconography and imagery

- One outline icon set across all surfaces (default: Lucide), 1.5px stroke, sizes 14 / 16 / 20px, colour `currentColor`.
- Avatars: small circles (24 / 28 / 32px) with initials on a soft tint derived from the chart palette. No stock photos of people.
- No illustrations or stock photography by default. The product UI itself is the hero visual.
- **Logo:** a filled dot (r 4) at the centre of a 240 degree arc (r 10, stroke 3.2, round caps) on a 32 x 32 grid. The arc is a full circle drawn with `pathLength="360"`, `stroke-dasharray="240 120"` and `stroke-dashoffset="-15"`, which leaves a 120 degree opening at the top right and lets the loading animation work without changing shape. Colour `currentColor`: white on the gradient and on dark glass. The SVG is always inline, never a `<use>` (a CSS animation does not reach inside it). Geometry and SVG strings come from `@radarnaque/design/logo`.
- **Generated icons:** the extension icon is a square tile with 22% rounded corners filled with `--gradient-compact`, with the white logo (75% of the tile at 16px, 62% above). PNG at 16, 32, 48, 96 and 128px, plus the favicon and the Open Graph image, are generated by `packages/design/scripts/icons.ts` and committed. Check legibility on a light and a dark toolbar.
- Lucide icons used by the UI (close, chevron, retry) live in `@radarnaque/design/icons`.

---

## 3. Components

All components live in one shared package (or folder) and are used by every surface.

**Buttons**

- **Primary**: white pill, `--text-on-light`, weight 500, padding 0 20px (0 28px on landing), primary shadow. Hover: lift -1px, shadow slightly larger. One primary per view.
- **Secondary**: transparent, 1px `--border-strong`, `--text-1`, `--r-pill` on marketing, `--r-s` in admin.
- **Ghost**: no border, `--text-2`, hover `--bg-3`.
- **Danger**: ghost style with `--danger` text; destructive confirmations use a filled `--danger` button inside the confirm dialog only.
- Disabled: 40% opacity, no hover effect, `cursor: not-allowed`.
- Loading: keep width fixed, replace label with a small spinner plus the label ("Saving").

**Links**: `--text-2`, underline with `text-underline-offset: 3px` and 1px thickness, hover brightens to `--text-1`. Never brightly coloured.

**Inputs**: height 36px, `--bg-1` fill, 1px `--border-default`, `--r-s`, placeholder `--text-3`. Focus: `--focus-ring`. Error: border `--danger` plus helper text below. Labels above the field in `text-xs`/500, `--text-2`.

**Badges / chips**: height 22px, `--r-pill`, `text-xs`/500, soft semantic background with full semantic text colour. Always include a text label.

**Status / score indicator**: for any risk, health or confidence value, show the number (serif `display-s` or larger), a short verdict word, and a semantic colour bar or ring. Thresholds defined once in shared code.

**List rows** (popup, activity feeds): avatar or icon left, title `text-s`/500 `--text-1`, snippet `text-xs` `--text-3` single line truncated, timestamp right-aligned `text-xs` tabular. Row height 52 to 60px, divider `--border-subtle`, hover `--bg-3`, selected: `--accent-soft` background plus 2px left `--accent` bar.

**Panels / cards**: `--bg-2` (or glass on gradient), 1px `--border-subtle`, `--r-m`, padding 16 to 24px. Use sparingly: a card must group something. No card grids for marketing content.

**Tables** (admin): header row `label` style, `--text-3`, sticky; rows 44px (36px compact mode), `text-s`; numeric columns right-aligned tabular; row hover `--bg-3`; row click opens a detail drawer; bulk-select checkbox column; pagination or virtual scrolling past 100 rows.

**Tabs / segmented control**: underline style in admin (2px `--accent` indicator), segmented pill style in popup.

**Toasts**: bottom-right (admin), bottom-center (popup), glass-strong, auto-dismiss 4s, never for errors that need action.

**Modals / drawers**: `--bg-1`, `--r-l` (modals), floating shadow, overlay `rgba(2,11,45,0.6)` with 4px blur. Escape closes, focus is trapped and restored.

**Empty states**: serif `display-s` title, one muted line, one action. Optional faint `--gradient-compact` glow behind (opacity 0.15 max).

**Loading**: skeletons in `--bg-3` with a slow shimmer (1.6s). No spinners for full regions.

**Errors**: inline, plain language, what happened plus what to do, with a retry action.

---

## 4. Surfaces

### 4.1 Landing page

Structure:

1. **Utility nav**: very small, low-contrast link(s) top-right (e.g. "Dashboard", "Docs") plus one external affordance (store page or GitHub icon). Logo/wordmark small top-left if the brand has one. Nothing else.
2. **Hero**: full-width `--gradient-hero`. Centered serif `display-xl` product name or promise in the upper half, a short sans tagline (`text-l`, white), one muted supporting line, then a white pill CTA ("Add to Chrome, it's free" or equivalent) with generous spacing between each.
3. **Product preview**: a wide browser-window mockup (`--r-l`, dark chrome bar with three dots and a fake URL field) overlapping the bottom of the hero. Inside: a realistic page from the product's real use case, with **the extension popup open, anchored under the toolbar icon top-right**, showing the main result state. Optional second mockup: a cropped admin dashboard view behind or below, smaller. Use real-looking product content. Mockup floats slowly (section 2.6).
4. **Feature bullets**: one centered horizontal row of four short benefits separated by small dot markers (`·` or a 4px circle), `text-m`, `--text-2`. Wraps to 2x2 on mobile. No cards, no icons grid.
5. **Install / action section**: solid `--bg-0`. Centered serif `display-l` action heading, white pill install button, one muted `text-s` line with underlined inline links (privacy policy, supported browsers, source code).
6. **Footer**: wide and sparse. Left: a small privacy/data statement (what the extension reads and stores). Right: compact group of underlined resource links. `text-xs`, `--text-3`.

Rules:

- Centered, very sparse above the fold; density only inside the mockup.
- **Exception:** on the landing the gradient follows the scroll from the top to the bottom of the page. It is the only surface where the gradient goes beyond a single area.
- Page `<title>` 65 characters maximum, plus meta description, Open Graph image (built from the hero + mockup).
- Responsive at 1440, 1024, 768, 390. On mobile the mockup becomes the popup alone, centered and slightly tilted is forbidden: keep it flat.

### 4.2 Extension popup

The popup is an **account popup**: it shows the signed-in state, the plan and the quota, with no analysis result. The "Result" and "Unsupported page" states below wait for the phase that will display the result in the popup.

Constraints: Chrome caps popups at 800x600. Design for **380px wide**, height between 480px and **600px max**. The popup must be useful within 150ms of opening.

Layout (top to bottom):

1. **Header (56 to 64px)**: `--gradient-compact` background, product mark + name in serif `display-s` white on the left, one ghost icon button right (settings or account menu). This is the popup's only atmospheric moment. A 1px `--gradient-hairline` may separate it from the body.
2. **Context line**: `text-xs` `--text-3` showing what the popup is acting on (current site / tab title, truncated).
3. **Primary result panel**: the one thing the user opened the popup for (a score, a status, a summary). Panel style, serif number, verdict badge, one sentence of explanation.
4. **Details**: list rows or a short key/value list (max 5 visible items, then "See all in dashboard").
5. **Action bar (sticky bottom, 64px)**: one white pill primary action full width or right-aligned, plus an underlined link to open the full dashboard in a new tab.

States to design explicitly (each is a screen, not an afterthought):

- Loading (skeleton of the result panel)
- Result (normal, warning, danger variants)
- Unsupported page ("Open a supported page to start", with examples)
- Signed out (serif title, one line, white pill "Sign in")
- Error / offline (what happened, retry)
- First run / onboarding (max 2 steps)

Rules:

- Only the details region scrolls; header and action bar stay fixed. No horizontal scroll ever.
- No hover-only affordances (keyboard users and fast clicks).
- All assets and fonts bundled; no remote scripts (Manifest V3).
- Persist the last result so reopening is instant, then refresh in the background.

### 4.3 In-page UI (content script)

For badges, tooltips or panels the extension injects into third-party pages:

- Render inside a **Shadow DOM** root with `all: initial` on the host to block page CSS in both directions. Load the token file inside the shadow root.
- The in-page badge shows the AI analysis only.
- Default form: a compact glass pill (height 24 to 28px, `--r-pill`, `text-xs`/500) with the semantic dot and a short label. Click expands a small glass card (max 320px wide) with the detail and a link to open the popup or dashboard.
- Never shift the host page layout; position absolutely or use an overlay layer. `z-index` 2 147 483 000 for the pill and its panels, never `2147483647`.
- Never mimic the host site's UI or branding. The injected UI must be recognisably ours.
- Provide a per-site "hide on this site" control.

### 4.4 Options page

Opens in a full tab. Same app shell as the admin (section 4.5) but single column, max-width 720px, centered. Serif `display-m` title, settings grouped in panels with label + description + control on each row. Save automatically with a subtle "Saved" toast, or a sticky save bar if changes must be confirmed.

### 4.5 Admin dashboard

Here density is the product. Keep the shell quiet so the data can be dense.

**Shell**

- Background `--bg-0`. Optional 1px `--gradient-hairline` at the very top of the viewport as the only atmospheric touch.
- **Sidebar** 240px (collapsible to 64px icon rail), `--bg-1`, border-right `--border-subtle`. Product mark top, nav items 36px with icon + `text-s` label, active item `--accent-soft` background + `--text-1`. Account menu at the bottom.
- **Top bar** 56px: breadcrumb left, global search (`Cmd/Ctrl+K`) center or right, environment badge if not production, notifications icon.
- Content max-width 1440px, padding 32px (24px under 1280px).

**Page anatomy**

1. Page header: serif `display-m` title, one muted `text-s` description, actions right-aligned (one primary white pill or secondary button max, the rest in an overflow menu).
2. KPI row: 3 to 5 panels, each with a `label`, a serif `display-m` value (tabular), and a delta in `text-xs` with semantic colour and arrow. No sparklines unless they answer a question.
3. Main content: filter bar (search + chips + date range) above a table, or a chart panel above a table.
4. Detail: row click opens a right drawer (480 to 640px) with the record, its history timeline and actions. Full page only for complex records.

**Charts**

- Use `--chart-*` in order, `--chart-grid` gridlines, axis labels `text-xs` `--text-3`, no chart borders, no 3D, no pie charts with more than 4 slices (prefer bars).
- Tooltips: glass-strong, tabular numbers.
- Every chart has a title stating what it shows and the time range.

**Login / auth screens**

- The one place in the admin where the gradient appears: full-bleed `--gradient-hero` (or `--gradient-compact`), centered glass panel 400px wide with serif title, inputs, white pill submit.

**Rules**

- Destructive actions always confirm, naming the object ("Delete 3 reports?").
- Every list has an empty state, a loading state and an error state.
- Keyboard: tables navigable, `Esc` closes drawers, `/` focuses filter search.
- Breakpoints: full layout 1280+, collapsed sidebar 1024 to 1279, below 1024 the sidebar becomes a drawer and tables turn into stacked rows for key columns only.

### 4.6 Shared assets

- Favicon / extension icons: 16, 32, 48, 128px, a simple mark legible at 16px on both light and dark browser toolbars (test both).
- Chrome Web Store assets (1280x800 screenshots, 440x280 promo tile) built from real popup and dashboard screens on the gradient background.
- Transactional emails (if any): white background, navy text, serif heading, one white-on-navy pill button. Emails are the only light surface by default.

---

## 5. Quality checklist (run before calling any UI done)

- [ ] Screenshot every surface: landing at 1440 / 768 / 390, popup at 380x600 in every state, admin at 1440 and 1024, in-page UI on at least two real host sites.
- [ ] Pixel check: alignment to the 4px grid, consistent radii, no stray borders, no text touching edges, no truncation that hides meaning, no layout shift on load.
- [ ] Contrast: body text 4.5:1 minimum, large text and UI controls 3:1, including on glass over the gradient.
- [ ] Focus visible on every interactive element; full keyboard path works.
- [ ] `prefers-reduced-motion` honoured.
- [ ] No horizontal scroll at any width.
- [ ] Only tokens used: no raw hex values, font sizes or radii outside the shared token file.
- [ ] Copy is the product's real copy, short, and consistent in tone across surfaces.
- [ ] Lint and visual/unit tests pass with no flakes.

---

## 6. Never

- Use logos, wordmarks, product names, copy, illustrations, photography or icon sets from the reference design, or imply any affiliation with it.
- Put the gradient behind data (tables, charts, dense lists) or use it on more than one area per screen.
- Use bold serif, serif under 20px, or more than two typefaces (plus optional mono).
- Use semantic colours decoratively, or convey status with colour alone.
- Build card grids for marketing features, or stack glass on glass.
- Add bouncy, energetic or decorative animation.
- Load remote code or fonts in the extension.
- Let the injected UI inherit or alter host page styles.
- Ship a screen without its loading, empty and error states.
