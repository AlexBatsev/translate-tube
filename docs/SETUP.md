# Setup guide

About 10 minutes. You need a Windows, macOS or Linux computer with Chrome or Edge.

## 1. Install the extension

1. Go to the [Releases page](https://github.com/AlexBatsev/translate-tube/releases) and download the newest `translate-tube-x.y.z.zip`.
2. Unzip it to a folder you will keep (for example `Documents\translate-tube`). Don't delete this folder later: the browser loads the extension from it.
3. Open `chrome://extensions` (Edge: `edge://extensions`).
4. Turn on **Developer mode** (top right in Chrome, left side in Edge).
5. Click **Load unpacked** and choose the unzipped folder (the one with `manifest.json` inside).
6. Click the puzzle icon in the toolbar and pin **Translate Tube**.

The setup page opens by itself. If not, right-click the toolbar icon → **Options**.

**Updating:** download the new zip, unzip it over the same folder, then click the reload ↻ button on the extension's card in `chrome://extensions`. Your settings and cards stay.

## 2. Get a free Gemini key (recommended)

1. Open [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key** and copy it.
3. In the setup page choose **Google Gemini**, paste the key, press **Test**. You should see a green "Works with …" line. Leave the model on **Automatic**.

The free tier has a daily limit, which is plenty for watching videos. Other providers are described in the [README](../README.md#ai-providers).

## 3. Install Anki and AnkiConnect

1. Install Anki desktop from [apps.ankiweb.net](https://apps.ankiweb.net) and open it.
2. In Anki: **Tools → Add-ons → Get Add-ons…**, enter code `2055492159`, click OK, then restart Anki.
3. In the extension settings, section **Anki**, click **Connect to Anki**. Anki shows a window asking whether to allow Translate Tube: click **Yes**.

The extension creates a deck (default "Translate Tube") and a note type called "Translate Tube".

To study on your phone, create a free [AnkiWeb](https://ankiweb.net) account, press **Sync** in Anki desktop, and use AnkiDroid (Android) or AnkiMobile (iPhone) with the same account.

When Anki is closed, new cards wait in the extension (the toolbar icon shows how many). They are sent within a minute after you open Anki. You can also export them from the **Cards** tab and import the file in Anki with **File → Import**.

## 4. Use it

1. Open any YouTube video that has subtitles (auto-generated ones work too).
2. Click the Translate Tube icon or press <kbd>Alt</kbd>+<kbd>T</kbd>. The side panel opens next to the video.
3. **Transcript** tab: click a word or drag over a phrase to translate it, then **Add to Anki**.
4. **Prepare** tab: press **Start** and use the keyboard to go through the hard sentences before watching.

## Troubleshooting

- **"YouTube did not return the subtitles"** – press <kbd>C</kbd> on the video to turn subtitles on once, then click "try again" in the panel.
- **"No subtitles in your learning language"** – the video has no subtitles in that language. Check the language in Settings.
- **"Anki is not running"** – open Anki. Cards are kept and sent later.
- **Ollama "403"** – quit Ollama and start it with the environment variable `OLLAMA_ORIGINS=chrome-extension://*`.
- **Gemini "429"** – the free daily limit is used up. Wait until tomorrow or pick another model in Settings.
