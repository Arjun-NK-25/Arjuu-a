#!/usr/bin/env python3
"""Inject the voice-command overlay into the cloned chat frontend.

The chat UI (e2e-chatbot-app-next) is cloned fresh from databricks/app-templates
at every app start, so the voice feature is applied to the clone *before*
`npm install` / `npm run build` run:

1. Copy scripts/voice_overlay.js into the frontend's `client/public/` dir so it
   is served as a static asset at `/voice-overlay.js`.
2. Append a `<script defer src="/voice-overlay.js"></script>` tag to
   `client/index.html` so the browser loads the overlay.

Both steps are idempotent, and any failure just disables the overlay — the app
still starts normally.
"""

import shutil
from pathlib import Path

OVERLAY_MARKER = "voice-overlay.js"
SCRIPT_TAG = '<script defer src="/voice-overlay.js"></script>'
MAIN_TSX_IMPORT = "import './voice-overlay.js';"
EMPTY_SUBMIT_GUARD = "if (!input.trim()) {"


def inject_voice(frontend_dir: Path) -> bool:
    """Patch the cloned frontend with the voice overlay. Returns True on success."""
    try:
        client = Path(frontend_dir) / "client"
        if not (client / "index.html").is_file():
            print(f"WARNING: {client / 'index.html'} not found; skipping voice overlay.")
            return False

        # 1. Static asset: served by express.static() from client/dist at
        #    /voice-overlay.js (Vite copies client/public/* into dist/).
        public_dir = client / "public"
        public_dir.mkdir(parents=True, exist_ok=True)
        overlay_src = Path(__file__).parent / "voice_overlay.js"
        shutil.copyfile(overlay_src, public_dir / "voice-overlay.js")

        # 1b. Bundled copy imported from the app entry point, so the overlay
        #     runs even if the HTML script tag is dropped by the bundler.
        #     (The overlay guards itself against double execution.)
        src_dir = client / "src"
        main_tsx = src_dir / "main.tsx"
        if src_dir.is_dir() and main_tsx.is_file():
            shutil.copyfile(overlay_src, src_dir / "voice-overlay.js")
            main_text = main_tsx.read_text()
            if MAIN_TSX_IMPORT not in main_text:
                main_tsx.write_text(
                    main_text.replace(
                        "import './index.css';",
                        f"import './index.css';\n{MAIN_TSX_IMPORT}",
                        1,
                    )
                )

        # 1c. Guard the chat form against empty submissions. The template
        #     submits on Enter even when the input is empty, and the chat API
        #     rejects those with 400 "bad_request:api".
        input_tsx = src_dir / "components" / "multimodal-input.tsx"
        if input_tsx.is_file():
            input_text = input_tsx.read_text()
            if EMPTY_SUBMIT_GUARD not in input_text:
                patched = input_text.replace(
                    "onSubmit={(event) => {\n"
                    "            event.preventDefault();\n"
                    "            if (status !== 'ready') {",
                    "onSubmit={(event) => {\n"
                    "            event.preventDefault();\n"
                    "            if (!input.trim()) {\n"
                    "              return; // ignore empty submissions\n"
                    "            }\n"
                    "            if (status !== 'ready') {",
                    1,
                )
                if patched != input_text:
                    input_tsx.write_text(patched)
                    print("✓ Empty-message submit guard added to chat input.")

        # 1d. JARVIS-style suggested actions for the chat UI.
        actions_tsx = src_dir / "components" / "suggested-actions.tsx"
        if actions_tsx.is_file():
            actions_text = actions_tsx.read_text()
            if "JARVIS" not in actions_text:
                patched = actions_text.replace(
                    "  const suggestedActions = [\n"
                    "    'How can you help me?',\n"
                    "    'Tell me something I might not know',\n"
                    "  ];",
                    "  const suggestedActions = [\n"
                    "    'Good evening, JARVIS. What can you do for me?',\n"
                    "    'JARVIS, what is the current time?',\n"
                    "  ];",
                    1,
                )
                if patched != actions_text:
                    actions_tsx.write_text(patched)
                    print("✓ JARVIS suggested actions installed in chat UI.")

        # 2. Load the script from the page as well (idempotent)
        index_path = client / "index.html"
        html = index_path.read_text()
        if OVERLAY_MARKER not in html:
            if "</body>" not in html:
                print("WARNING: no </body> tag in index.html; skipping voice overlay.")
                return False
            html = html.replace(
                "</body>", f"  {SCRIPT_TAG}\n  </body>", 1
            )
            index_path.write_text(html)

        print("✓ Voice command overlay injected into chat UI (mic + spoken replies).")
        return True
    except Exception as e:
        print(f"WARNING: voice overlay injection failed: {e}")
        return False
