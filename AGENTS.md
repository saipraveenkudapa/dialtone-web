<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Dialtone — design rules

`design/Dialtone.html` is the approved mockup of this product. `app/industry.css`
is its design system, extracted verbatim. Both are the source of truth for the
look. Build screens to match the mockup; do not redesign.

- Never hardcode a color, spacing, radius, or shadow. Use the tokens in
  `app/industry.css` (`--color-*`, `--space-*`, `--radius-*`, `--shadow-*`).
- Reuse the system classes: `.card`, `.btn`/`.btn-primary`/`.btn-secondary`/
  `.btn-ghost`, `.input`, `.field`, `.radio`, `.seg`/`.seg-opt`, `.tag`(+
  `-accent`/`-accent-2`/`-neutral`/`-outline`), `.table`, `.dialog`, `.nav`,
  `.blueprint` (+ `<Corners />`), `.elev-*`, `.text-muted`.
- Extend by adding a class to `app/app.css`. No inline styles, no per-component
  CSS files, no component library.
- Fonts come from `next/font` in `app/layout.tsx` and are bound to
  `--font-heading` / `--font-body` in `app/app.css`. Never set font-family
  anywhere else.
- Money is integer cents. Timestamps are UTC in the DB, rendered in the
  location's timezone.
