# Repository Guidelines

## Project Structure & Module Organization
- `manifest.json` wires the Chrome extension entry points and permissions.
- `src/background.js` brokers AI requests and persists settings via `chrome.storage.sync`.
- `src/content-script.js` watches Gmail compose surfaces, renders the modal, and dispatches `SMART_REPLY_GENERATE` events.
- `src/popup.html`, `src/popup.js`, and `src/styles.css` define the configuration UI and modal styling; keep new UI assets under `src/`.
- `gmail_source_example.txt` is a reference thread snapshot; use it when tweaking parsing logic.

## Build, Test, and Development Commands
- No package install is required; vanilla JS is shipped directly from `src/`.
- Load the extension unpacked: `chrome://extensions` → enable Developer Mode → "Load unpacked" → select the repo root.
- Package for sharing with `zip -r smart-reply.zip manifest.json src` from the project root.

## Coding Style & Naming Conventions
- JavaScript uses two-space indentation, single quotes, trailing semicolons, and descriptive camelCase helpers; reserve SCREAMING_SNAKE_CASE for shared constants.
- Guard against repeated DOM injection (`window.hasRunSmartReplyExtension`) and prefer early returns for clarity.
- CSS selectors follow the `smart-reply__` block-element pattern; keep new styles scoped to avoid Gmail collisions.
- Keep files ASCII-only and document non-obvious logic with short comments.

## Testing Guidelines
- Manual verification is the primary workflow: load the unpacked extension, open Gmail, focus a compose editor, and trigger Smart Reply.
- Check both English and Japanese threads, multi-message conversations, and custom tone selections; confirm graceful handling when the AI request fails or times out.
- Before publishing, run through the configuration popup to ensure API key/model persistence works across browser restarts.

## Commit & Pull Request Guidelines
- Follow the existing short, present-tense summaries (`gemini API利用に置き換えた`); English or Japanese is acceptable if concise.
- Include in PR descriptions: goal, notable UI changes, manual test notes (e.g., "Verified in Gmail web with Gemini"), and screenshots or screen recordings when UI is affected.
- Link related issues and call out breaking permission changes or new storage keys for reviewer attention.

## Configuration & Security Tips
- Never log API keys; scrub console output before submitting PRs.
- Settings live in `chrome.storage.sync`; document any schema changes to ease upgrades and avoid data loss.
- For alternative AI providers, confirm header requirements and rate limits before committing endpoint updates.

## Agent-Specific Instructions
- 思考過程と最終的な回答は原則として日本語で記述してください。
