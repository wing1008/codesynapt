# Theme plugin

A theme plugin is the simplest plugin type — just CSS. You override
the app's CSS variables under a `body[data-theme="your-id"]` selector,
and filegraph3d picks it up automatically.

- [Minimal example](#minimal-example)
- [Every variable you can override](#every-variable-you-can-override)
- [Palette construction](#palette-construction)
- [Decorations: corner brackets and accents](#decorations-corner-brackets-and-accents)
- [Dark vs light themes](#dark-vs-light-themes)
- [Studying built-in themes](#studying-built-in-themes)
- [Common mistakes](#common-mistakes)

## Minimal example

```
plugins/my-theme/
├── manifest.json
└── theme.css
```

**`manifest.json`:**

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "version": "1.0.0",
  "type": "theme",
  "main": "theme.css",
  "minAppVersion": "0.10.0",
  "license": "MIT"
}
```

**`theme.css`:**

```css
body[data-theme="my-theme"] {
  --bg:     #1A1A1A;
  --fg:     #F0F0F0;
  --accent: #FF8800;
}
```

That's a working theme. It won't look great because you've only set 3
of ~30 variables, but it'll load. Read on for the rest.

## Every variable you can override

filegraph3d's UI is parameterized by ~30 CSS custom properties. The
full list:

### Backgrounds

| Variable | Used by | Notes |
|---|---|---|
| `--bg` | Body background | The main canvas background. Pure color, no alpha. |
| `--bg-deep` | Very deep accents | Slightly darker than `--bg`. |
| `--bg-elev` | Raised elements | Tooltips, dropdowns. Use `rgba(...)` for translucency. |
| `--bg-glass` | All floating panels | The "frosted glass" panel background. Should be `rgba()` with ~0.85 alpha. |
| `--bg-solid` | Where solid is required | Settings panel sections, etc. |

### Borders

| Variable | Used by | Notes |
|---|---|---|
| `--border` | Default panel borders | Should be visible but not loud. |
| `--border-hot` | Active / focused borders | Brighter version of `--border`. |
| `--border-edge` | Subtle dividers, separators | Nearly invisible (alpha ~0.05). |

### Foregrounds

| Variable | Used by | Notes |
|---|---|---|
| `--fg` | Primary text | Should pass contrast against `--bg`. |
| `--fg-dim` | Secondary text | Labels, less important info. |
| `--fg-mute` | Tertiary text | Captions, kicker text. |
| `--fg-faint` | Quaternary text | Disabled, divider labels. |

### Accents (semantic colors)

| Variable | Semantic role | Where |
|---|---|---|
| `--accent` | Default information / focus | Buttons, highlights, brand dot, search focus border |
| `--accent-warm` | Active set / starred | Star buttons, pipelines panel, active markings |
| `--accent-pink` | Warning / danger | Delete buttons, error states |
| `--accent-cool` | Secondary focus | Focus ripples (less common) |
| `--danger` | Errors | Validation failures, destructive confirmation |

### Typography

| Variable | Used by |
|---|---|
| `--font-mono` | Monospace text (code, data, default body) |
| `--font-display` | Display text (logo, headers) |

The defaults expect `'JetBrains Mono'` to be available, with fallbacks
to `'SF Mono'`, `ui-monospace`, `Menlo`. You can change to any font
stack you like; the user must have it installed.

### Layout

| Variable | Used by |
|---|---|
| `--radius` | Border-radius for panels, buttons | `0` = brutalist, `4-6px` = friendly, `12px+` = bubbly |
| `--space-1` through `--space-6` | 4px grid spacing | Rarely needs override |

### Motion & decoration flags

| Variable | What it controls |
|---|---|
| `--decoration` | `1` to show corner brackets on panels, `0` to hide |
| `--grain` | Opacity of background noise overlay (`0` to `0.05`) |
| `--motion-scale` | Multiplier for ambient animations (`0` = none, `1` = default, `1.5` = more) |

### Easing

| Variable | Used by |
|---|---|
| `--ease-out` | Smooth ease-out for hover transitions |
| `--ease-snap` | Snappy ease for selection changes |

## Palette construction

A good theme needs **5 colors** at minimum:

1. **Background** (`--bg`)
2. **Foreground** (`--fg`)
3. **Three accents** (`--accent`, `--accent-warm`, `--accent-pink`)

### Step-by-step

**1. Pick a background.** This sets the mood:
- Near-black (`#0A0A0A`) — neutral terminal feel
- Tinted dark (`#1A1B26` Tokyo Night, `#2A1810` warm) — character
- True white (`#FAFAFA`) — light mode

**2. Pick a foreground that contrasts.**
- For dark bg: `#E0E0E0` to `#F5F5F5`
- For light bg: `#1A1A1A` to `#333333`
- Aim for **WCAG AA** contrast (4.5:1 minimum for normal text).

**3. Pick `--accent`.** This is the main signal color. Used everywhere
you want to draw the eye. Choose something that:
- Stands out against `--bg`
- Doesn't fight `--fg` (don't pick a similar hue)

**4. Pick `--accent-warm` and `--accent-pink`.** These are semantic:
- `--accent-warm` = active set, starred (golds, oranges work great)
- `--accent-pink` = danger, deletion (reds, hot pinks)

The three accents should be **distinguishable at a glance**. If they're
all bluish, users can't tell what each one means.

**5. Generate the supporting colors.**

Common pattern (in HSL):
```
--fg:       hsl(H, S,   95%)
--fg-dim:   hsl(H, S*0.8, 75%)
--fg-mute:  hsl(H, S*0.5, 50%)
--fg-faint: hsl(H, S*0.3, 35%)
```

Where `H, S` are the hue/saturation of the base foreground.

For borders, use the accent color at low alpha:
```
--border:      rgba(R, G, B, 0.16)   /* visible */
--border-hot:  rgba(R, G, B, 0.55)   /* active */
--border-edge: rgba(R, G, B, 0.06)   /* nearly invisible */
```

Where `R, G, B` is your accent color's RGB.

## Decorations: corner brackets and accents

filegraph3d's built-in themes have **corner brackets** on panels —
small `┌` `┐` `└` `┘` marks that frame each panel. These are part of
the "Observatory" aesthetic.

You control them with `--decoration`:

```css
body[data-theme="my-clean-theme"] {
  --decoration: 0;   /* hide all corner brackets */
}
```

```css
body[data-theme="my-bold-theme"] {
  --decoration: 1;   /* show corner brackets (default) */
}
```

When `--decoration: 0`:
- Corner brackets disappear
- ASCII dividers in welcome screen hide
- `[ ]` brackets around the brand label hide

This single switch controls roughly two dozen decorative elements.

## Dark vs light themes

Light themes need a few extra tweaks. Set everything as usual, then:

```css
body[data-theme="my-light-theme"] {
  --bg:           #FAFAFA;
  --fg:           #1A1A1A;
  --accent:       #0066CC;
  --accent-warm:  #B87000;
  --accent-pink:  #CC2233;

  /* Soften the grain overlay (it looks bad on white) */
  --grain: 0;

  /* Borders need to be dark on light bg */
  --border:       rgba(0, 0, 0, 0.08);
  --border-hot:   rgba(0, 0, 0, 0.3);
  --border-edge:  rgba(0, 0, 0, 0.04);
}

/* Hide the grain overlay specifically for this theme */
body[data-theme="my-light-theme"]::before {
  opacity: 0 !important;
}
```

The grain overlay is set on `body::before` and uses
`mix-blend-mode: overlay`, which looks fine on dark but adds ugly
specks on light. Force it off.

## Studying built-in themes

The seven built-in themes are great references. They live in the
app's `public/style.css`. Each is implemented as a `body[data-theme="..."]`
block:

- `observatory` — the default, brutalist + corner brackets
- `minimal` — Obsidian-style, soft and quiet
- `terminal` — Linear-style, monochrome
- `maximal` — bold gradients
- `carbon` — CRT phosphor green
- `mono` — Tokyo Night warmth
- `daylight` — light mode

Open `style.css` and grep for `body[data-theme=` to find each one.
Copy the parts you like.

## Common mistakes

### "My theme doesn't show up"

- Did you **fully quit** the app (Cmd/Ctrl+Q) and reopen? Themes are
  injected at startup.
- Is `manifest.json` valid JSON? Try `jsonlint.com`.
- Is the folder name and `manifest.id` matching? They don't have to be
  identical, but the `id` determines what selector you need (it's
  `body[data-theme="<id>"]`, not the folder name).

### "Colors look right but layout is weird"

You probably forgot `--decoration` or `--radius`. Set them explicitly
even if you want defaults — relying on inheritance gives unpredictable
results when users switch from another theme.

### "It looks fine in my theme but broken in others"

Don't define your CSS variables outside the `body[data-theme="..."]`
selector. If you do, they leak into other themes. Bad:

```css
/* ❌ leaks to all themes */
:root {
  --accent: #FF0000;
}
```

Good:

```css
/* ✅ scoped to this theme only */
body[data-theme="my-theme"] {
  --accent: #FF0000;
}
```

### "Light mode text is unreadable"

Check your contrast ratios. On light backgrounds:
- `--fg` should be very dark (`#1A1A1A` to `#333`)
- `--fg-mute` should still be readable (`#666` minimum)

Use a contrast checker like `webaim.org/resources/contrastchecker/`.

### "My theme breaks the file tree colors"

The colored squares next to filenames come from the **app's** file-type
palette, not your theme. They're hardcoded by extension (`.js` = yellow,
`.tsx` = blue, etc). If you want a different file-type palette, that's
a different feature — currently not user-overridable.

## Next steps

- Try the [sunset-theme example](../../examples/sunset-theme/) — a
  warm coral-orange theme you can copy and modify.
- Read the [exporter guide](./exporter.md) for your next plugin type.
- Or jump to the [API reference](../api-reference.md) for the full
  surface.
