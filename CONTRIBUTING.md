# Contributing

Thanks for helping! Translate Tube is plain JavaScript with no build step.

1. Fork and clone, then `npm install`.
2. Load the repository folder in `chrome://extensions` → **Load unpacked**.
3. Make your change on a branch, add or update tests in `tests/` for logic in `src/lib/`.
4. Run `npm test && npm run lint && npm run check`.
5. Open a pull request describing what changed and how you tried it.

Guidelines:

- Keep it serverless: the extension talks only to YouTube, the user's chosen AI provider and the local AnkiConnect.
- Never log or send API keys anywhere except the provider they belong to.
- New permissions in `manifest.json` need a reason in the pull request.
