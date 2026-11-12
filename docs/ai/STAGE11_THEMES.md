# Stage 11 — Design prep: three dealt themes (Unit A)

Date: 2026-11-12. Branch: `feat/stage11-design` (base `feat/stage11-launch` @ `210eabd`).
Status: **themes dealt, NOT applied, NOT picked.** The pick is Rishabh's.
Scope of this doc: design prep only. No CSS, no page edits, no tokens file,
no dependency was added. The pre-existing (Stage 0) design stays untouched
whatever he picks — a theme applies only to the new-flow pages listed below.

## Deal output (verbatim)

Command (run in the worktree, Node available):

```
node ~/workspace/custom-skills/hallmark/scripts/theme.mjs deal --genre modern-minimal --prompt "Farmer Marketplace — farmer-first agricultural trading platform, mobile-first Hindi/English transactional flows: farmer verification, crop passport, negotiation, group selling, logistics tracking, disputes, AI assistant, notifications, admin dashboard, public transparency dashboard"
```

Output:

```
deal: farmer-marketplace-farmer-first-agricultural-9c6d·84890325·2026-11-12·r0 · genre modern-minimal
1. Coral (coral) · light/grotesk-sans/warm · warm grey paper and a felt desk, cotton stationery lit from the left, General Sans throughout with Geist Mono figures, letterpress card controls, coral pressed into the stock for the one settled state · fits: platform, dashboard · references/themes/coral.jpg, pictured as Conversational FAQ, Desk hero
2. Wayfind (wayfind) · light/mono/cool · cool grey paper, blue-black ink, Chivo Mono throughout, square 2px ink borders, ink plates, cobalt for what is live, amber for figures on ink · fits: platform, logistics · references/themes/wayfind.jpg, pictured as Station Sequence, Stage hero
3. Dose (dose) · light/grotesk-sans/chromatic-green · warm morning paper with a fibre grain and window light, translucent tinted plastic, green-black ink, Schibsted Grotesk over Instrument Sans with DM Mono pharmacy labels, moulded controls, one pharmacy green · fits: tracking · references/themes/dose.jpg, pictured as Care Register, Organiser hero
next: look at the pictures, pick the material this prompt wants, read references/themes/<slug>.md, then theme.mjs scaffold <slug> --dealt "<n>/3, seed farmer-marketplace-farmer-first-agricultural-9c6d·84890325·2026-11-12·r0"
```

Deal seed: `farmer-marketplace-farmer-first-agricultural-9c6d·84890325·2026-11-12·r0`.
Genre: `modern-minimal`. Reroll: 0 (first deal, kept as dealt).
Theme pictures were NOT inspected in this unit — the pick is Rishabh's, from
this doc plus the pictures at `~/workspace/custom-skills/hallmark/references/themes/<slug>.jpg`.
Theme details below are taken from `references/themes/<slug>.md` in the Hallmark skill.

New-flow pages a picked theme would touch (and only these):
`VerificationQueue` (admin), `FarmerProfile`, `Requirements`,
`NegotiationThread`, `GroupBuys`, `GroupBuyDetail`, `Transporters`,
`ShipmentTracking`, `Disputes`, `DisputeDetail`, `Assistant`,
`Notifications`, `Transparency`, `admin/Dashboard`, `admin/Metrics`,
`admin/Moderation`, `admin/Reconciliation`, plus the new-flow components
`CropPassportCard`, `OfferCard`, `AssistantChat`, `DeliveryProof`,
`NotificationBell`, `PlatformMetrics`. A theme changes look only — never
copy, behaviour, routes, APIs, or data.

---

## 1. Coral (`coral`) — dealt 1/3

**Palette.** Warm grey paper `oklch(97% 0.006 55)`, cotton stock
`oklch(98.8% 0.0045 80)`, felt desk `oklch(94.3% 0.008 64)`; ink
`oklch(21% 0.012 38)`, muted `oklch(47% 0.013 45)`; one coral accent
`oklch(74% 0.125 30)` (deep coral `oklch(54% 0.165 29)` for focus), settled
state pressed in paid-coral `oklch(55.5% 0.15 33)`. Warm, never cool paper,
never a blue signal.

**Type voice.** General Sans throughout (600 display, 400/500 body, sentence
case, tracking −0.03em); Geist Mono 400 for figures in columns only
(General Sans has no tabular figures). Labels are General Sans 500, a step
smaller, sentence case. A lone price sets at 2–3× display size.

**Material.** Warm grey paper and a felt desk, cotton stationery lit from the
left: records as cotton sheets, envelopes and index cards with real edges;
controls are letterpress cards (8px radius, 48px tall, pressed-in label);
the settled state (paid, signed, booked) is pressed into the stock in coral.
Texture is generated (cotton/felt SVG tiles), never a photograph of paper.

**What it changes on the new-flow pages.**
- Verification queue + farmer passport read as an index of cotton cards:
  a submission is a card, its document a sheet, approval the pressed-coral
  "settled" stamp.
- Negotiation offers become correspondence cards; the accepted offer is the
  one pressed in coral, the rest stay plain stock.
- Dispute timeline and shipment events become records on the desk; the
  resolved/delivered state is the pressed mark, not a coloured badge.
- Admin metrics / transparency: the one figure that matters (GMV, stuck
  money) sets huge on the ink board beside a ruled list, per the theme's
  "price on the board" range.
- Buttons become letterpress cards (48px, 8px radius); the primary is an ink
  board card. Choice sets (filters, status) become a groove pressed into
  cotton with a card riding to the chosen stop.

**Why it fits this product.** The platform's job is paperwork that ends in
money changing hands — a requirement, a quote, an order, a settlement. Coral
plays that job as documents on a desk, which matches the trust story
(verification, passport, escrow) better than a generic dashboard skin. Warm,
plain second-person voice suits Hindi-first farmers reading on a phone. The
single coral signal maps cleanly onto the one thing a user must spot: what
is settled (paid / verified / delivered / resolved).

**What it would NOT change.** The pre-existing Stage 0 design (Home, Product
page, Buyer/Farmer dashboards' existing sections, checkout, Navbar, Footer,
Hero, the Tailwind `green-deep`/`cream` tokens in `tailwind.config.js`).
No copy, no Hindi/English wording, no flow, no status model. Coral's
"never a pill button" rule would not be retrofitted onto pre-existing pages.

---

## 2. Wayfind (`wayfind`) — dealt 2/3

**Palette.** Cool grey paper `oklch(95.5% 0.006 250)`, blue-black ink
`oklch(16% 0.014 262)`, muted `oklch(47% 0.016 260)`; cobalt
`oklch(51% 0.22 264)` for what is live, amber `oklch(81% 0.16 82)` for
figures on ink only (never amber text on paper). Three colourways exist
(`platform` default, `night`, `signal`); the pick would state one in the
stamp. No texture, no gradient, no rounded cards.

**Type voice.** Chivo Mono throughout — 800 display, 400 body, 500 labels,
all sentence case, untracked, tabular numbers everywhere. Mono is the
material (the theme waives the usual "labels never mono" rule). Heads stay
short enough to read in one look (`h1` caps at 4.75rem).

**Material.** Public signage set as a page: square 2px ink borders on every
surface, ink plates that carry one instruction and its figure, cobalt for
what is live, amber figures on ink. Depth is borders, not shadows. A phone
screen built from the product takes a 9:19.5 frame in the 2px border.

**What it changes on the new-flow pages.**
- Shipment tracking becomes the theme's home ground: the route as a
  station sequence (booked → picked up → in transit → out for delivery →
  delivered as bordered plates joined by a 2px rule), the delivery OTP as a
  plate figure, the live status as the one cobalt element.
- Disputes and negotiations become status rows: name in 800, ends in 400,
  state at the right edge, one cobalt live dot on the row that just changed.
- Group selling / requirements become a departure board table on the ink
  band: crop in 500, pooled quantity in 800 amber, deadline as the minute.
- Admin metrics / transparency become figure-as-sign plates: one number at
  display size in a bordered plate, unit beside it.
- Buttons are square: cobalt-filled primary beside a transparent one with a
  2px ink border, 48–52px, Chivo Mono 800. Choice sets are square cells
  sharing 2px borders; the chosen cell fills ink with paper text.

**Why it fits this product.** Most of these flows are "where is it, what
happens next, how long" — exactly what signage answers at a glance, in
daylight, from three metres. That is the farmer use case: a phone in a
field, sun on the screen, one look to know if the truck is coming. Mono
tabular figures make prices, quantities, OTPs and times unambiguous, and the
single cobalt live-signal maps onto the one live thing per screen (current
shipment status, open offer, unread notification). Of the three, this is the
strongest fit for logistics tracking specifically.

**What it would NOT change.** The pre-existing Stage 0 design (same list as
Coral). No copy, no flow, no status model. The all-mono voice would not be
extended to pre-existing pages, and the theme's "never a proportional face
anywhere" rule applies only inside the new-flow pages it restyles — it must
not leak into the existing DM Sans / Playfair pages. Hindi (Devanagari)
rendering in Chivo Mono needs a check at application time: Chivo Mono has
no Devanagari glyphs, so Hindi text would fall back to a system face —
that fallback must be named in the theme-application plan before building,
or Hindi-heavy screens (Assistant, Notifications) keep a paired Devanagari
face.

---

## 3. Dose (`dose`) — dealt 3/3

**Palette.** Warm morning paper `oklch(97.6% 0.011 88)` with a fibre grain;
green tints `oklch(96.5% 0.02 160)` / `oklch(93% 0.036 160)`; green-black
ink `oklch(21% 0.025 170)`; one pharmacy green `oklch(50% 0.13 160)` (deep
`oklch(42% 0.11 162)`, soft mint `oklch(88% 0.08 160)` for what is
checked). Seven pale plastic tints (`--p-mon` … `--p-sun`) colour bands by
day/slot, never by state. Never red or amber for a missed/late state — that
is grey. Three grounds exist (`white` default, `green`, `night`); the pick
would state one in the stamp.

**Type voice.** Schibsted Grotesk 700 display (tracking −0.03em, line-height
1.02, sentence case); Instrument Sans 400/500 body at 16–18px; DM Mono 400/500
for times, doses and pharmacy labels (`08:00`, `500 mg`) — at text size in a
sentence, at title size where a timetable's first column is the time.

**Material.** Translucent tinted plastic and daylight: warm paper with a
generated fibre grain, window light drifting across the hero, bands of soft
tinted plastic like a pill organiser (62% alpha tint, glint line on the top
edge, deeper shade at the foot); a label is grained white paper on plastic
with a tear-off stub and a double-ringed green stamp naming the time and
who. Radii read as an app: 10px controls, 14px surfaces, 999px tags.

**What it changes on the new-flow pages.**
- Group selling and negotiation become plastic bands/trays: each stage a
  full-width band in its own tint, the pooled quantity in Schibsted at
  display size, the deadline in DM Mono beside its line.
- The crop passport becomes a pharmacy label: grained white, DM Mono
  throughout, a green stamp for "verified" (grey when pending/rejected —
  never red).
- The assistant becomes labels + stamps: each grounded answer a label
  stating the figure, the time and the source; a no-data answer the same
  label in grey.
- Notifications become a dose schedule: quiet hours and per-type toggles as
  plastic keys, mint when checked; delivery status as a stamped label.
- Dispute SLA becomes a time in DM Mono on a label — overdue in grey, never
  red/amber.
- Controls are moulded plastic: 52px, 10px radius, a 1px rim with a 3px rim
  below, sinking 3px on press; primary is green plastic, secondary clear.

**Why it fits this product.** The platform's trust story is "exact and
unhurried": a verified farmer, a locked price, a delivered OTP, a settled
share. Dose is trustworthy because it is exact — one green does every
signal, times are set like a label, and nothing shouts. It is the most
mobile-native of the three (app radii, 52px moulded controls, schedule as
the organising idea), and its "never red for a late state" rule fits a
product where a late delivery or an open dispute must stay calm, not
alarming. The plastic-band range maps directly onto the multi-step flows
(negotiation, group close, shipment) without inventing new components.

**What it would NOT change.** The pre-existing Stage 0 design (same list as
Coral). No copy, no flow, no status model. The seven day-tints are for
bands/slots only and would not be used as status colours (the theme forbids
plastic tint as a signal). Same Devanagari caveat as Wayfind, smaller:
Schibsted Grotesk / Instrument Sans have no Devanagari glyphs either, so
Hindi text falls back to a system face — the fallback must be named at
application time.

---

## How the pick works

1. Rishabh picks one of Coral / Wayfind / Dose (or asks for a re-deal —
   `theme.mjs deal --reroll 1` — or a custom direction).
2. The post-pick theme application (a later Stage 11 unit, NOT this one)
   runs `theme.mjs scaffold <slug> --dealt "<n>/3, seed …"` and restyles
   only the new-flow pages above, under the Hallmark floor (tokens at
   `:root`, `prefers-reduced-motion` fallback, `sloplint --render` clean).
3. The other two themes are dropped, not merged — a theme is one material,
   never a mix.
4. Open question carried to the pick: the Devanagari fallback face for the
   picked theme (Wayfind and Dose both set Latin-only display faces; Coral's
   General Sans is Latin-only too — all three need a named Hindi fallback,
   since Assistant and Notifications are Hindi-first).
