# Translate Tube

Learn a language from the YouTube videos you already watch.

Translate Tube is a free, open-source Chrome / Edge extension. It opens a side panel next to the video (never on top of it) with:

- **Transcript** – the subtitles as a scrolling text. The sentence being spoken is highlighted, with the lines before and after it. The whole transcript is analysed once when a video opens, so words that are hard for your level are underlined right away, and you can turn on a translation line under each sentence. Click an underlined word for its meaning at once; click any other word (or drag over a phrase) to get a translation **in this context**. Idioms and phrasal verbs are treated as one unit, with each word explained too.
- **Prepare** – go through the video's hard sentences *before* watching. The keyboard does the rest:

  | Key | Action |
  | --- | --- |
  | <kbd>Space</kbd> | show / hide the sentence translation |
  | <kbd>Tab</kbd> | next highlighted word in this sentence |
  | <kbd>A</kbd> | add the word to your cards |
  | <kbd>S</kbd> | I know it (never highlighted again) |
  | <kbd>Enter</kbd> | next highlighted word, then the next sentence |
  | <kbd>Backspace</kbd> | back to the previous sentence |
  | <kbd>−</kbd> / <kbd>+</kbd> | fewer / more highlighted words (changes your level at once) |
  | <kbd>P</kbd> | play this sentence in the video |
  | click | look up any other word |

- **Cards** – words you add wait in a review list, grouped by video and kept until you send them. Fix a word or translation, tick single words of a phrase to get a card for each, then send everything to [Anki](https://apps.ankiweb.net). Each card has the word in dictionary form, its translation, a memory note, the original sentence and a link back to the exact moment in the video. If Anki is closed, cards wait in the extension and are sent automatically later.

There is no server: everything runs in your browser, with your own AI key.

## AI providers

Pick one in Settings, paste a key, press **Test**. The model is chosen automatically (the newest fast model that answers, switching if one is retired or overloaded); you can also pick one yourself.

| Provider | Cost | Notes |
| --- | --- | --- |
| Google Gemini | free tier | Recommended. Key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Anthropic Claude | paid API | Key from [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenAI | paid API | Key from [platform.openai.com](https://platform.openai.com/api-keys) |
| DeepL | free tier | Translation only: no memory notes, no hard-word highlighting |
| Ollama | free, local | Runs on your computer. Start Ollama with `OLLAMA_ORIGINS=chrome-extension://*` |

Keys are stored only in `chrome.storage.local` on your computer and are sent only to the provider you chose.

## Install

See **[docs/SETUP.md](docs/SETUP.md)** for the step-by-step guide (extension, Anki, AnkiConnect, AI key).

Short version:

1. Download `translate-tube-x.y.z.zip` from [Releases](../../releases) and unzip it.
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked**, choose the unzipped folder.
3. The setup page opens: pick your languages, AI provider and level.
4. Install Anki desktop + the AnkiConnect add-on (code `2055492159`), then click **Connect to Anki** in Settings.
5. Open a YouTube video and click the Translate Tube toolbar button (or <kbd>Alt</kbd>+<kbd>T</kbd>).

## Development

No build step: the extension is plain JavaScript modules.

```sh
npm install      # dev tools only (ESLint)
npm test         # unit tests (node --test)
npm run lint
npm run build    # dist/translate-tube-<version>.zip
```

Load the repository folder itself with **Load unpacked** while developing; press the reload button on `chrome://extensions` after changes.

```
manifest.json
src/background.js          service worker: Anki queue, setup page, side panel
src/content/main-world.js  runs in the YouTube page, captures signed caption URLs
src/content/youtube.js     video position / seek / transcript for the side panel
src/sidepanel/             Transcript, Prepare and Cards tabs
src/options/               settings + first-run wizard
src/lib/providers/         one small module per AI provider
src/lib/ai.js              prompts (contextual explanation, hard-word analysis)
src/lib/anki.js            AnkiConnect client + offline queue
src/anki/                  the Anki card template
```

**Adding an AI provider:** copy one of `src/lib/providers/*.js`, implement `listModels` and `complete` (or `translate`), add its host to `host_permissions` in `manifest.json`, and list it in `src/lib/providers/index.js`.

**Releasing:** bump `version` in both `manifest.json` and `package.json`, merge, then push a tag `vX.Y.Z`. The release workflow builds the zip and attaches it to a GitHub release.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
