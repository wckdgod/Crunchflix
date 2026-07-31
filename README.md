# CRUNCHFLIX 🎬

![Version](https://img.shields.io/badge/version-2.0.4-red.svg)
![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Brave-blue.svg)
![Simkl API](https://img.shields.io/badge/Scrobbler-Simkl-green.svg)

**CRUNCHFLIX** is a powerful, privacy-focused browser extension that automatically scrobbles your watch history from **Netflix**, **Crunchyroll**, **Jio Hotstar**, and **Prime Video** directly to [Simkl](https://simkl.com).

---

## ✨ Features

- **🚀 Multi-Platform Scrobbling**: Automatic, real-time playback tracking (`start`, `pause`, `stop`) across **Netflix**, **Crunchyroll**, **Jio Hotstar**, and **Prime Video**.
- **🔑 Simkl PIN Device Auth**: Fast, hassle-free authentication via Simkl PIN device flow (`simkl.com/pin`).
- **🎯 Precision Title & Episode Extraction**:
  - **Netflix**: Scrapes player metadata, `SxxExx` badges, and NQ/Shakti member API payloads.
  - **Crunchyroll**: Parses JSON-LD structured data and broadcasts metadata down to cross-origin player iframes.
  - **Jio Hotstar**: Uses player UI accessibility labels, `TVEpisode` JSON-LD, and `og:title` metadata.
  - **Prime Video**: Extracts shadow DOM elements (`.atvwebplayersdk-title-text`, `.atvwebplayersdk-subtitle-text`) and iframe broadcasts.
- **🎨 Rich Dashboard Popup**: Real-time watching status badge, progress percentage, dominant poster color extraction, episode offset overrides, and manual title fixers.
- **📊 History Sync & Backup**: Manage and bulk-sync past viewing history to your Simkl profile.

---

## 🛠️ Installation

Since this is a developer build, load it as an **Unpacked Extension** in Chrome, Edge, Brave, or Opera:

1. **Download / Clone the Repository**:
   ```bash
   git clone https://github.com/wckdgod/Crunchflix.git
   ```
2. **Open Extensions Manager**:
   - **Chrome**: Navigate to `chrome://extensions`
   - **Edge**: Navigate to `edge://extensions`
3. **Enable Developer Mode**:
   - Toggle the **Developer mode** switch in the top-right corner.
4. **Load Unpacked Extension**:
   - Click **Load unpacked** and select the `Crunchflix` repository directory (where `manifest.json` is located).

---

## ⚙️ Configuration & Connection

1. Open the **CRUNCHFLIX** extension popup in your browser toolbar.
2. Click **Connect to Simkl**.
3. A window will display your unique 5-character **PIN Code**.
4. Open [simkl.com/pin](https://simkl.com/pin), enter the PIN code, and authorize your app.
5. The extension will automatically save your token and start scrobbling immediately!

---

## 💡 Troubleshooting & FAQ

### Service Worker Inspector
If you ever want to view live background service worker logs in Edge or Chrome:
- Go to `edge://serviceworker-internals` (or `chrome://serviceworker-internals`).
- Search for `CRUNCHFLIX` and click **Inspect**.
- Alternatively, right-click the extension toolbar icon and click **Inspect popup**.

### Extension Updates / Reloads
If you reload the extension while a streaming tab is open, refresh the streaming tab (F5) to re-establish the content script communication port.

---

## 📜 Credits & References

- **[Simkl API](https://simkl.com)** — JSON REST API & Scrobbler services.
- **Universal Trakt Scrobbler** — Metadata extraction patterns for streaming platforms.
- **Built with Google Antigravity** — AI-assisted agentic development.

---

## 📄 License

[MIT License](LICENSE)
