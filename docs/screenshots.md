# Updating the screenshots

The README and project site use the same images in `docs/assets/`. Capture the
running app, not a design mockup. Use a disposable workspace so screenshots do
not include personal chats, keys, file paths, or account details.

From the repository root, start an isolated API:

```bash
demo_dir=$(mktemp -d)
BUNJI_DATA_DIR="$demo_dir" BUNJI_API_PORT=4319 npm run api
```

In a second terminal, point Vite at it:

```bash
BUNJI_API_PROXY_TARGET=http://127.0.0.1:4319 npm run dev -- --host 127.0.0.1 --port 5175
```

Open `http://127.0.0.1:5175/`. If you add a sample conversation, use only
public, generic content. Capture the desktop workbench at about 1440 × 900 and
the phone layout at about 390 × 850. Save them as `docs/assets/web-desktop.png`
and `docs/assets/web-mobile.jpg`, then check both files visually before a PR.
The site imports those same files, so no second copy is needed.
