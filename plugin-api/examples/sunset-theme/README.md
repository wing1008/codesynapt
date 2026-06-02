# sunset-theme

A warm coral-orange theme inspired by sunset over the ocean. Useful
as a starting point for your own theme plugin — copy and modify.

## What it looks like

| Element | Color |
|---|---|
| Background | Deep brown `#1A0F0A` |
| Foreground | Cream `#FFE4C4` |
| Primary accent | Warm orange `#FF8C42` |
| Active set color | Amber `#FFB347` |
| Warning color | Coral red `#FF6B6B` |

The theme uses 4px rounded corners and no decorative corner brackets,
giving it a softer feel than the default Observatory theme.

## Install

Copy this folder into your filegraph3d plugins directory:

```
macOS:   ~/Library/Application Support/FileGraph 3D/plugins/
Windows: %APPDATA%\FileGraph 3D\plugins\
Linux:   ~/.config/FileGraph 3D/plugins/
```

Quit and reopen filegraph3d. Open **Settings → Appearance** — "Sunset"
appears in the theme grid. Click it.

## Files

- **`manifest.json`** — declares the plugin as type `theme`. Theme
  plugins don't need any permissions because they only contribute CSS.

- **`theme.css`** — overrides CSS variables under the
  `body[data-theme="sunset-theme"]` selector. The selector value
  matches the `id` in the manifest.

## What to change

Open `theme.css` and tweak. Some easy starting points:

### Different color family

The whole theme is built around `--accent: #FF8C42`. Swap that for any
other hue and pick three colors that:

- `--bg`: a deep version of (or complement to) the accent
- `--fg`: a light tint of the accent or a neutral
- `--accent-warm`: a brighter sibling color
- `--accent-pink`: contrast color for warnings

### Add corner brackets

```css
body[data-theme="sunset-theme"] {
  --decoration: 1;   /* show corner brackets on panels */
}
```

### Make it brutalist

```css
body[data-theme="sunset-theme"] {
  --decoration: 1;
  --radius:     0;   /* sharp corners */
}
```

### Lighter background

If you want a "sunrise" version instead:

```css
body[data-theme="sunset-theme"] {
  --bg:        #FFF4E6;
  --fg:        #4A2810;
  --grain:     0;
  /* ... and adjust borders/accents accordingly */
}
body[data-theme="sunset-theme"]::before {
  opacity: 0 !important;   /* turn off the dark-mode grain */
}
```

## License

MIT — fork, modify, redistribute freely.

## More

For the complete list of CSS variables and theming guidance, see
[../../docs/types/theme.md](../../docs/types/theme.md).
