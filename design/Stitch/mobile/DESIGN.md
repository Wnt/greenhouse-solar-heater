# Design System Specification: High-End Health & Editorial Dark Mode

## 1. Overview & Creative North Star
**The Creative North Star: "The Digital Sanctuary"**

This design system is not a utility; it is an atmosphere. Moving beyond the "app-as-a-tool" paradigm, this system treats user data with the reverence of a high-end editorial magazine. We reject the rigid, boxy constraints of standard Material or Human Interface guidelines in favor of a fluid, "sanctuary-like" experience.

The visual identity is defined by **intentional asymmetry**, where text-heavy editorial insights overlap minimalist data visualizations. We avoid a flat grid by using depth and tonal shifts to create a hierarchy that feels organic. The layout should feel like it is "breathing"—expansive white space (even in dark mode) and soft transitions allow the user to focus on their well-being without cognitive overwhelm.

---

## 2. Colors & Surface Philosophy

The palette is rooted in the deep obsidian of the night, transitioning through atmospheric slates to provide a sense of calm.

### Core Tokens
- **Background:** `#0c0e12` (The foundation)
- **Primary (Soft Gold):** `#e9c349` (Used for peak achievements and status)
- **Secondary (Cyan/Teal):** `#43aea4` (Used for balanced metrics and stability)
- **Surface Tiers:** From `surface-container-lowest` (#000000) to `surface-bright` (#252c39).

### The "No-Line" Rule
**Explicit Instruction:** Do not use 1px solid borders to define sections. In this system, boundaries are created through color temperature and tonal shifts. A `surface-container-high` card should sit on a `surface` background to define its shape. Lines are reserved exclusively for data—never for structural containment.

### The Glass & Gradient Rule
To achieve a premium "frosted" aesthetic, floating elements (like bottom navigation bars or active modals) must use **Glassmorphism**. 
- **Recipe:** `surface-container-low` at 60% opacity with a 20px Backdrop Blur.
- **Signature Textures:** Use subtle linear gradients for large interactive surfaces. Transition from `primary` to `primary-container` at a 15-degree angle to add "soul" to CTA buttons, preventing them from looking like flat, plastic stickers.

---

## 3. Typography

The typography is a dialogue between the classic (Serif) and the clinical (Sans-Serif).

- **Display & Headline (Newsreader):** An elegant, high-contrast serif. This is used for "Insights"—human-readable summaries that tell the story of the data (e.g., *"Your heart rate is finding its rhythm."*). It adds an authoritative, editorial voice.
- **Body & Label (Manrope):** A clean, modern sans-serif with generous tracking. This is used for raw data, metrics, and technical labels. It ensures that while the headlines feel like a story, the data feels like a fact.

**Hierarchy Note:** Use a drastic scale difference. A `display-lg` headline should tower over `body-md` text to create a clear "Entry Point" for the eye, mimicking the layout of a premium broadsheet.

---

## 4. Elevation & Depth

We eschew traditional drop shadows for **Tonal Layering**. Depth is a function of light, not darkness.

- **The Layering Principle:** Stack surfaces to create focus. Place a `surface-container-lowest` card (Pure Black) inside a `surface-container-high` section to create an "etched-in" look, or vice versa to create "lift."
- **Ambient Shadows:** Shadows are rare. When used for floating action buttons or high-priority modals, use a 40px blur at 6% opacity. The shadow color should be a deep Slate Blue (#161a21), never pure grey.
- **The "Ghost Border" Fallback:** If accessibility requirements demand a border, use the `outline-variant` token at **15% opacity**. It should be felt, not seen.
- **Nesting:** Always maintain a 2-step token gap when nesting (e.g., a `surface-container-highest` element should never sit directly on a `surface-container-high` element; skip a level to ensure the contrast is intentional).

---

## 5. Components

### Cards & Lists
**Forbid the divider.** Instead of lines, use the **Spacing Scale** (8/12/16) to create "islands" of content.
- **Cards:** Use `xl` (1.5rem) corner radius. Elements inside the card should align to a distinct internal padding of `6` (1.5rem). 
- **Data Lists:** Use a subtle background shift (`surface-container-low`) on hover/active states rather than a border.

### Buttons & Chips
- **Primary Button:** Uses the Soft Gold gradient. Roundedness: `full`. No border.
- **Filter Chips:** Use `surface-container-high` with a `label-md` Manrope font. When active, transition to `secondary` (Cyan) with white text.
- **Action Chips:** (e.g., "Log Period") should use the "Ghost Border" to feel light and non-obstructive.

### Data Visualization (The "Thin Line" Rule)
Charts are the crown jewels of this system. 
- Use `px` (1px) stroke widths for axes.
- Use high-contrast colors (`primary` or `secondary`) against the dark background. 
- Points on a graph should be "Glowing"—use a small outer glow (2px blur) of the same color to make the data feel alive.

### Navigation Bar
A glassmorphic "Dock" at the bottom of the screen. No background color—only a `surface-container-low` at 40% opacity with a heavy backdrop blur. Use minimalist, thin-stroke icons that transition from `on-surface-variant` to `primary` when active.

---

## 6. Do’s and Don’ts

### Do
- **Do** embrace asymmetry. Allow a chart to bleed off one edge of a card if it creates a sense of movement.
- **Do** use "Editorial" phrasing. Instead of "Sleep Data," use "How you rested."
- **Do** use the `tertiary` (Slate/Ice) colors for secondary data points to keep the UI from feeling too "loud."

### Don’t
- **Don’t** use pure white (#FFFFFF) for text. Use `on-surface` (#e0e5f5) to prevent eye strain in dark mode.
- **Don’t** use 1px lines to separate list items. Use a 12px or 16px gap.
- **Don’t** use standard "Success" green or "Warning" orange. Use the `secondary` (Cyan) for positive states and `error_dim` for alerts to maintain the sophisticated palette.
- **Don't** crowd the interface. If a screen feels busy, increase the spacing tokens by one level.