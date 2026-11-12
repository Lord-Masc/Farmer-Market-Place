# Stage 11 — Design audit: lib-first map + mobile-first gap notes (Unit A)

Date: 2026-11-12. Branch: `feat/stage11-design` (base `feat/stage11-launch` @ `210eabd`).
Status: **audit only, NO fixes.** Fixes belong to the PWA/a11y unit or to the
post-pick theme application. No code was changed in this unit (docs only).
Method: read the new-flow pages and components listed in §2, grepped for the
patterns named per finding, and verified each cited line by reading it.
No live browser check was run — every finding is a code-level audit note to
be confirmed on a real phone at application time.

## 1. Lib-first audit

Installed today (from `package.json`, verified): React 19, `react-dom`,
`react-router-dom` 7, `@supabase/supabase-js`, Tailwind 3.4 (+ Vite, ESLint,
PostCSS, Autoprefixer as dev tooling). **No UI library is installed.** There
is no toast system, no modal/drawer primitive, no OTP input, no stepper, no
timeline and no skeleton in the repo — the new flows hand-roll all of these
with Tailwind classes (see §3 for what that costs on mobile).

The skills below are playbooks / source registries, NOT installed packages.
Nothing from them is in `node_modules`, and nothing was added in this unit
(CONSTRAINTS: ask before adding dependencies). "Available" below means "the
component exists as copyable source in that registry" — installing it still
takes a source-add step, and several options pull a NEW npm dependency,
which needs Rishabh's approval first.

| Component the new flows need | Where it is used | Lib / registry mapping | Needs a new dependency? |
|---|---|---|---|
| Bottom sheet / drawer (mobile offer, dispute, close-group forms) | `NegotiationThread.jsx` (quote/counter/accept forms), `GroupBuyDetail.jsx` (join/negotiate/close), `DisputeDetail.jsx` (resolve form) — all currently inline sections, not sheets | shadcn **Drawer** (skill file names Drawer; depends on `vaul`) or shadcn **Sheet**; kokonutui drawer | YES — `vaul` (Drawer) or `@radix-ui/react-dialog` (Sheet). Rishabh's approval required. |
| Stepper (multi-step status) | `DisputeDetail.jsx:193-205` (4-step status pills), `ShipmentTracking.jsx:194-200` (status events list) | No stepper in the shadcn skill's component list (grep: no "stepper"); kokonutui has none named either. Check 21st.dev registry at application time; otherwise hand-build from Tailwind primitives (small, no dep) | NO if hand-built or 21st.dev source copy; YES only if a chosen registry item lists one |
| OTP input (delivery OTP entry) | `ShipmentTracking.jsx:152-156` renders the buyer OTP as plain text (`text-3xl tracking-[0.3em]`); `DeliveryProof.jsx` collects it — no OTP input component exists | shadcn **input-otp** (skill lists `input-otp`? — NOT confirmed in the skill file grep; the shadcn registry does ship `input-otp`) | YES — `input-otp` package. Rishabh's approval required. Verify the component exists in the registry at application time before promising it. |
| Timeline (shipment + dispute history) | `ShipmentTracking.jsx` events, `DisputeDetail.jsx` messages/evidence | No timeline primitive in shadcn/kokonutui skill files. 21st.dev registry search at application time; otherwise Tailwind hand-build (the current lists are simple stacked rows) | NO if hand-built / 21st.dev source copy |
| Stat cards (metrics, dispute stats) | `Disputes.jsx:141-150`, `admin/Dashboard.jsx:79-101`, `PlatformMetrics.jsx` | shadcn **Card** (source-only, no new dep) or kokonutui stat components (4 stat mentions in its skill file); current cards are already Tailwind hand-rolls and are fine | NO — Card is source-only; kokonutui stat copy is source-only |
| Toasts (success/error feedback) | Everywhere — currently inline `<p>` error text and `disabled:opacity-50` only; no toast infra exists in `src/` (grep for toast/Toast finds only unrelated matches) | shadcn **Sonner** (`sonner` package) or shadcn **Toast** (`@radix-ui/react-toast`) | YES — `sonner` or `@radix-ui/react-toast`. Rishabh's approval required. |
| Skeletons (loading states) | All new-flow list pages render plain "Loading..." text (`Requirements.jsx:155`, `GroupBuys.jsx`, `Notifications.jsx`, `VerificationQueue.jsx:160`); no skeleton anywhere in `src/` | shadcn **Skeleton** — source-only, pure Tailwind/CSS, no new dependency | NO |
| Smooth scroll | Not needed by any transactional flow; the new pages are forms/lists, not a scroll story | lenis (`npm i lenis`) — available per its skill, but no flow asks for it | YES if wanted — do NOT add; no use case in this stage |
| Motion / reveals | The dealt themes' motion is minimal CSS (Coral: one 6s desk play; Wayfind: step changes; Dose: 90s light drift). No GSAP-grade animation is required | gsap (`npm i gsap`, + `@gsap/react` for React) — available per its skill | YES if wanted — do NOT add unless the picked theme's application plan names a motion it cannot do in CSS |
| Animated micro-UI (spotlight cards, docks, count-ups) | None of the transactional flows need these; they are landing-page components | react-bits — 216 components as registry-JSON source copies; many list `gsap`/`three`/`ogl` as dependencies | Depends on the component — check its registry JSON `dependencies` at application time; do NOT add for transactional flows |
| One-off polished components | Any gap above with no shadcn answer (stepper, timeline) | 21st.dev registry via the `custom.21stdev` connector (MCP search, source copy into the project) | Source copy = NO new dep unless the item's `dependencies` list one — check per item |

**Bottom line for the coordinator.** The honest state is: lib-first does not
mean "already installed" here — it means "source-copy from a registry before
hand-building". The only zero-new-dependency wins available right now are
shadcn Skeleton / Card (source-only) and hand-built Tailwind steppers /
timelines. Everything else on the list (Drawer/Sheet, OTP input, toasts)
needs a new npm dependency and therefore Rishabh's approval under
CONSTRAINTS — do not let the theme-application unit `npm i` anything on its
own initiative. The approval question to put to him at pick time: "Drawer
(`vaul`), OTP input (`input-otp`) and toasts (`sonner`) — approve all three,
or hand-build?"

## 2. Pages audited

`src/pages/admin/VerificationQueue.jsx`, `src/pages/FarmerProfile.jsx`,
`src/pages/Requirements.jsx`, `src/pages/NegotiationThread.jsx`,
`src/pages/GroupBuys.jsx`, `src/pages/GroupBuyDetail.jsx`,
`src/pages/Transporters.jsx`, `src/pages/ShipmentTracking.jsx`,
`src/pages/Disputes.jsx`, `src/pages/DisputeDetail.jsx`,
`src/pages/Assistant.jsx`, `src/pages/Notifications.jsx`,
`src/pages/Transparency.jsx`, `src/pages/admin/Dashboard.jsx`,
`src/pages/admin/Metrics.jsx`, `src/pages/admin/Moderation.jsx`,
`src/pages/admin/Reconciliation.jsx`, plus `src/components/OfferCard.jsx`,
`src/components/CropPassportCard.jsx`, `src/components/AssistantChat.jsx`,
`src/components/DeliveryProof.jsx`, `src/components/NotificationBell.jsx`,
`src/components/PlatformMetrics.jsx`, `src/index.css`, `index.html`,
`tailwind.config.js`.

Verified OK (no action): `index.html:5` carries
`<meta name="viewport" content="width=device-width, initial-scale=1.0">`
with no `maximum-scale` / `user-scalable=no`; body inherits the browser
16px base (Tailwind preflight, no smaller `font-size` set in `index.css`);
every new-flow `<table>` sits inside an `overflow-x-auto` wrapper
(`GroupBuyDetail.jsx:494`, `ShipmentTracking.jsx:217`,
`Reconciliation.jsx:98`, `VerificationQueue.jsx:267`,
`PlatformMetrics.jsx:90,119`); grids are mobile-first
(`grid-cols-1 md:grid-cols-2 lg:grid-cols-3` throughout); form inputs are
`w-full … p-4` (≈56px tall, fine); primary submit buttons are `py-4`
full-width; the shipment OTP (`ShipmentTracking.jsx:156`, `text-3xl
tracking-[0.3em]`) fits a 360px viewport; loading and empty states exist on
nearly every list page (see §3.5).

## 3. Findings (audit only — no fixes made)

### 3.1 Touch targets under 44px (WCAG 2.5.8 / Apple HIG floor)

1. `src/pages/Notifications.jsx:258,266` — "Unread only" filter and
   "Load more" buttons are `px-4 py-1.5 text-[10px]` (~28px tall).
   Same pattern in `src/pages/Disputes.jsx:214` (status filter buttons) and
   `src/pages/admin/Reconciliation.jsx:84` (category filter buttons).
2. `src/pages/Notifications.jsx:372,385,395` — per-type preference controls:
   language `<select>` and both quiet-hours `<input type="time">` are
   `px-2 py-1` (~28px tall). The channel checkboxes
   (`Notifications.jsx:360-368`) use the native checkbox with no enlarged
   hit area.
3. `src/pages/admin/VerificationQueue.jsx:194,203` — Approve / Reject are
   `px-5 py-2.5 text-sm` (~40px — close, still under 44px).
   Same size on `src/pages/admin/Moderation.jsx:144,150` (Suspend /
   Reinstate) and `src/pages/DisputeDetail.jsx:306` (admin status buttons,
   `px-6 py-3` — ~48px, OK; listed here only so the reviewer does not
   re-flag it).
4. `src/components/AssistantChat.jsx:165` — starter-prompt chips are
   `px-4 py-2 text-sm` (~36px). The chat form's Voice / Send buttons have
   no vertical padding but stretch to the input's `p-4` height (~56px), so
   they are OK — do not "fix" them by shrinking the input.

### 3.2 Text scaling / legibility

5. `text-[10px]` uppercase labels carry real content on almost every
   new-flow page: `Requirements.jsx:173`, `GroupBuys.jsx:218`,
   `GroupBuyDetail.jsx:297`, `ShipmentTracking.jsx:125`,
   `Disputes.jsx:235-238`, `DisputeDetail.jsx:186-188,198`,
   `Notifications.jsx:290-296`, `OfferCard.jsx:35,89`,
   `AssistantChat.jsx:40,181`. 10px is below the 12px floor most mobile
   guidance uses and is hardest on Devanagari (Hindi) glyphs, which these
   flows render. Status pills are short tokens, so this is a legibility
   note, not a breakage — but the picked theme must not set body/label text
   below 12px on these screens.
6. `src/pages/Disputes.jsx:141` and `src/pages/admin/Dashboard.jsx:79` —
   stat grids start at `grid-cols-2` on mobile with `p-6` cards, so each
   card is ~160px wide on a 360px screen and ~112px of content width after
   padding. "No disputes yet" at `text-2xl` wraps to 3–4 lines; the
   "Avg resolution" label wraps too. Cramped, not broken.
7. Every new-flow `<main>` uses `pt-32 pb-20 px-[5%]` (e.g.
   `Requirements.jsx:109`, `NegotiationThread.jsx:313`,
   `Assistant.jsx:23`). The fixed Navbar is ~76px tall, so `pt-32`
   (128px) costs ~20% of a 360×640 viewport before any content. Cosmetic;
   the theme-application unit should confirm the offset against the real
   Navbar height on mobile rather than copying `pt-32` onto new screens.

### 3.3 Overflow / wrapping

8. `src/pages/admin/Moderation.jsx:126` — the looked-up user's UUID renders
   in a bare `<p className="font-black text-green-deep">` with no
   `break-all` / `truncate` / `overflow-wrap`. A 36-char UUID overflows a
   360px viewport. No `break-words` / `break-all` class exists anywhere in
   the new-flow pages (grep over `src/pages/` + `src/components/` returns
   only `truncate` uses in pre-existing dashboard code), so any long
   unbroken string (UUID, evidence filename, email) is an overflow risk
   wherever it is rendered as full text.
9. `src/components/AssistantChat.jsx:199` — the chat form is `flex gap-2`
   with no wrap and the input has `flex-1` but no `min-w-0`. On a ~320px
   viewport the Voice + Send buttons squeeze the input, which cannot shrink
   below its content size. Add `min-w-0` (or stack the buttons) at
   application time.
10. `src/pages/DisputeDetail.jsx:193-205` — the 4-step status strip is
    `flex flex-wrap` (wraps correctly on mobile) but the step pills are
    `text-[10px]` (see finding 5) and the `→` separators wrap onto their
    own line at the narrowest widths. Acceptable; revisit only if the
    picked theme restyles the stepper.
11. `src/index.css` sets `overflow-x: hidden` on `html`/`body` — horizontal
    overflow is masked rather than prevented, so an unhandled wide element
    clips silently instead of scrolling. The tables are already wrapped
    (§2), so this is a latent note, not a live bug; the Hallmark floor
    wants `overflow-x: clip`, which the theme application should adopt.

### 3.4 Focus / keyboard (a11y unit's scope, recorded here)

12. Zero `:focus-visible` rules exist in `src/` (grep: 0 matches), and 36
    `outline-none` uses sit in the new-flow pages and components — focus is
    shown only as `focus:border-amber`, a colour-only cue. Keyboard users
    get no visible focus ring. This is the single largest a11y gap in the
    new flows and belongs to the PWA/a11y unit, not to theme application.
13. `aria-label` / `aria-live` appear only in
    `src/components/NotificationBell.jsx:26` (bell `aria-label`). No
    `aria-live` region announces async results (offer accepted, dispute
    filed, notification marked read) anywhere in the new flows.

### 3.5 Loading / empty states (mostly present — gaps only)

14. `src/pages/admin/Moderation.jsx` — no page-level loading state: the
    lookup shows no spinner while `lookingUp` is true (the button only
    disables, `:115-116`); `actionBusy` covers suspend/reinstate (`:23`,
    `:62-78`) but there is no skeleton or text for the lookup itself.
15. `src/pages/Assistant.jsx` — no page-level loading/empty state, but none
    is needed: the page renders `AssistantChat`, which has its own empty
    state (`AssistantChat.jsx:153-171`, starter prompts) and sending state
    (`:190`). Recorded so the reviewer does not file it as missing.
16. Everything else checked has both states: `Requirements.jsx:155-161`,
    `GroupBuys.jsx:202`, `GroupBuyDetail.jsx:428-429`,
    `Transporters.jsx:192`, `ShipmentTracking.jsx:194-195`,
    `Disputes.jsx:157,163`, `DisputeDetail.jsx:238-239,269`,
    `Notifications.jsx:276-277`, `Transparency.jsx` (`loading` `:14-27`),
    `VerificationQueue.jsx:159-163` (loading + empty), `Reconciliation.jsx:75,95`.
    All list pages render "Loading…" as plain text — no skeleton component
    exists (see §1, Skeleton row).

## 4. What is NOT in this audit

- No live browser / device check was run (no 360px render, no Lighthouse,
  no axe) — findings 1–16 are code-level and must be confirmed on a real
  phone by the PWA/a11y unit.
- No PWA assessment (manifest, service worker, offline order status) — that
  is the sibling unit's scope.
- No security re-audit — that is the Stage 11 hardening unit's scope.
- No fixes were made and no files outside `docs/ai/` were touched.
