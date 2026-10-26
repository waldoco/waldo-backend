# Connector marks

Bundled into the dashboard as inline SVG (`?inline`); nothing is hotlinked. Each mark is a byte-for-byte copy of the
vendor artwork the Waldo landing site uses, unmodified, and names the service it stands for. `icons.tsx` keys them by
catalogue id or channel name.

| File | Used for | Source | Licence |
|---|---|---|---|
| `gmail.svg` | Google account rows | `waldo-landing/public/assets/connectors/gmail.svg`, added here in #858 | Original source not recorded |
| `google-calendar.svg` | Google account rows | `waldo-landing/public/assets/connectors/google-calendar.svg`, added here in #858 | Original source not recorded |
| `telegram.svg` | `telegram` chat row | `waldo-landing/public/assets/connectors/telegram.svg`, added here in #858 | Original source not recorded |
| `whatsapp.svg` | `whatsapp` chat row | `waldo-landing/public/assets/connectors/whatsapp.svg` (landing commit 86992b3) | Original source not recorded |
| `granola.svg` | `granola` catalogue tile | `waldo-landing/public/assets/connectors/granola.svg` (landing commit 86992b3) | Original source not recorded |
| `notion.svg` | `notion` catalogue tile | `waldo-landing/public/assets/connectors/notion.svg` (landing commit 86992b3) | Original source not recorded |
| `linear.svg` | `linear` catalogue tile | `waldo-landing/public/assets/connectors/linear.svg` (landing commit 86992b3) | Original source not recorded |
| `slack.svg` | `slack` catalogue id (no tile yet) | `waldo-landing/public/assets/connectors/slack.svg` (landing commit 86992b3) | Original source not recorded |

Each file was checked before bundling: no `<script>`, no `on*` attributes, no `href`/`xlink:href`, no
`<foreignObject>` or `<image>`. The only reference is Granola's internal `url(#clip…)`.

`todoist`, `imessage` and any id the console does not know draw a neutral lettermark (the label's initial in
design-system tokens). The landing site has no Todoist or iMessage mark, and a guessed logo is never drawn instead.

To add one: put the vendor's unmodified SVG here, add a row above with its source and licence, and add it to
`connectorLogos` in `icons.tsx` under its catalogue id or channel name.
