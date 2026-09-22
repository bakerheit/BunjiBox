# BunjiBox for macOS

Native SwiftUI client for the shared Bunji workspace. It talks to the same local
API as the web app and `bunji`, so agents, models, messages, activity, and token
usage stay synchronized.

Click an agent's name or avatar in the chat header, right-click it in the sidebar,
or choose **Edit profile…** in Settings to edit its name, description, and avatar.
The picture editor has **Avatar**, **Generate**, and **Upload** tabs. Pick a shape
and color, describe a new picture for ChatGPT to generate, or upload a PNG, JPG,
or WebP up to 5 MB. Generated pictures are previews until you choose **Use this
picture** and **Save changes**. Changes save to the shared workspace; Cancel
discards the draft. Pictures are center-cropped and resized to 256 × 256.

Generation uses the local Codex app-server's native image tool with your signed-in
ChatGPT account, not an API key or a starter-image collection. It uses your Codex
usage allowance ([OpenAI documentation](https://learn.chatgpt.com/docs/image-generation)).
Codex must be installed and support native image generation. The isolated image
session disables shell and other agent tools; it does not use the agent's chat or
memories. Long image generations have no total timeout. Retry reconnects to the
same request after a network error; Cancel stops it. Unsaved previews expire after
20 minutes or a Bunji service restart. Previously saved starter pictures still work.

Click anywhere across an agent's sidebar row to open its conversation.

Chat messages use the active agent's avatar color for subtle bubbles in light and
dark mode, with user messages on the right and replies on the left. White avatars
use a neutral tint. Both prompts and replies render spaced paragraphs, `#` headings,
numbered and bulleted lists (including nested lists), blockquotes, horizontal rules,
and pipe tables. Fenced code preserves whitespace, scrolls horizontally, and has a
Copy button. Text is selectable; HTTP, HTTPS, and email links are clickable.

Formatting is local presentation only; stored message text stays intact. The small
native parser does not implement all of CommonMark: table column alignment, HTML,
remote images, reference-style links, and indented code blocks are not rendered as
rich content. Use fenced code blocks. Incomplete fences remain readable. Verify
layout, selection, links, and Copy in the running app after building; the automated
checks cover parsing, code preservation, link filtering, and text contrast.

```bash
npm run macos:build
npm run macos:app
npm run macos:check
open apps/macos/dist/BunjiBox.app
```

The app checks `http://127.0.0.1:4318` and starts `npm run api` from the BunjiBox
repository when needed. Set `BUNJI_REPO_ROOT` if the repository is elsewhere.

This alpha uses Swift Package Manager so it builds with Apple Command Line Tools.
Open the package in full Xcode later for signing, app icons, sandbox entitlements,
and notarized distribution.
