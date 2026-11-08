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

**Updating:** download the new zip, unzip it over the same folder, then click the reload ↻ button on the extension's card in `chrome://extensions`, and refresh YouTube tabs that were already open. Your settings and cards stay. Don't remove the extension to update it: removing deletes your settings, known words and cards. To be safe, use **Settings → Save and restore your data → Download my data** first.

## 2. Get a free Gemini key (recommended)

1. Open [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key** and copy it.
3. In the setup page choose **Google Gemini**, paste the key, press **Test**. You should see a green "Works with …" line. Leave the model on **Automatic**.

The free tier limits requests per minute and per day. A one-hour video takes roughly 60–90 requests to analyse. When the limit is reached, the panel pauses and continues by itself. You can also add a **Backup AI** in Settings (for example a local Ollama or a paid key), which takes over while the main one is out of its limit. Other providers are described in the [README](../README.md#ai-providers).

## 3. Install Anki and AnkiConnect

The last setup step asks whether you want to use Anki. Choose **Yes, use Anki** and follow the steps shown there:

1. Install Anki desktop from [apps.ankiweb.net](https://apps.ankiweb.net) and open it.
2. In Anki: **Tools → Add-ons → Get Add-ons…**, enter code `2055492159`, click OK.
3. Restart Anki (close it completely and open it again).
4. Anki asks whether to allow Translate Tube: click **Yes**.

The setup page notices Anki by itself and turns green when it is connected. If you choose **Not now**, words are still collected in the Cards tab and can be exported; you can connect Anki later in Settings.

The extension creates a deck (default "Translate Tube") and a note type called "Translate Tube".

To study on your phone, create a free [AnkiWeb](https://ankiweb.net) account, press **Sync** in Anki desktop, and use AnkiDroid (Android) or AnkiMobile (iPhone) with the same account.

When Anki is closed, sent cards wait in the extension and go to Anki within a minute after you open it. The toolbar icon shows how many cards are waiting for review or for Anki. You can also export them (the **⋯** menu on the **Cards** tab) and import the file in Anki with **File → Import**.

## 4. Use it

1. Open any YouTube video that has subtitles (auto-generated ones work too).
2. Click the Translate Tube icon or press <kbd>Alt</kbd>+<kbd>T</kbd>. The side panel opens next to the video.
3. **Transcript** tab: click a word or drag over a phrase to translate it, then **Add to cards**.
4. **Prepare** tab: press **Start** and use the keyboard to go through the hard sentences before watching. Use **−** (lower level, more words) / **+** (higher level, fewer words) if too few or too many words are highlighted.
5. **Cards** tab: check the words you added, then press **Send to Anki**.

## Troubleshooting

- **"Refresh the tab"** – the YouTube tab was open before the extension was installed or updated. Refresh it (F5).
- **"Add your … key in Settings"** – no AI key yet, or setup was skipped. Open Settings (⚙).
- **"AI limit reached: continues in …"** – the free limit of your AI key is used up for now. The panel continues by itself; a Backup AI in Settings avoids the wait.
- **Shorts** – work like normal videos, but most Shorts have no subtitles.
- **"YouTube did not return the subtitles"** – press <kbd>C</kbd> on the video to turn subtitles on once, then click "try again" in the panel.
- **"No subtitles in your learning language"** – the video has no subtitles in that language. Check the language in Settings.
- **"Anki is not running"** – open Anki. Cards are kept and sent later.
- **Ollama "403"** – quit Ollama and start it with the environment variable `OLLAMA_ORIGINS=chrome-extension://*`.
- **Anki asks to set up again / lost the add-on** – Anki keeps add-ons per computer user. Install AnkiConnect again (step 3) and restart Anki.
