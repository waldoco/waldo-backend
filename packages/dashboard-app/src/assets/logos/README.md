# Connector marks

Bundled into the dashboard as inline SVG (`?inline`); nothing is hotlinked. Each mark is the vendor's own artwork,
unmodified. `icons.tsx` keys them by catalogue id or channel name.

| File | Used for | Source | Licence |
|---|---|---|---|
| `gmail.svg` | Google account rows | Byte-identical to `waldo-landing/public/assets/connectors/gmail.svg`, added in #858. Upstream source not recorded. | Not recorded. Kept by the owner's 6 Oct 2026 decision (see `ASSET_NOTICES.md`). |
| `google-calendar.svg` | Google account rows | Byte-identical to `waldo-landing/public/assets/connectors/google-calendar.svg`, added in #858. Upstream source not recorded. | Same as above. |
| `telegram.svg` | Telegram chat row (`telegram`) | Byte-identical to `waldo-landing/public/assets/connectors/telegram.svg`, added in #858. Upstream source not recorded. | Same as above. |

These ids have no bundled mark and draw a neutral lettermark (the label's initial, in design-system tokens) until
a clearly licensed mark is added: `granola`, `notion`, `todoist`, `linear`, `slack`, `imessage`, `whatsapp`, and any
id the console does not know. A guessed or redrawn logo is never used in their place.

To add one: put the vendor's unmodified SVG here, add a row above with its source and licence (Simple Icons is
CC0), and add it to `connectorLogos` in `icons.tsx` under its catalogue id or channel name.
