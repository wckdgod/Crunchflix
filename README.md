# CRUNCHFLIX

**CRUNCHFLIX** is a browser extension that scrobbles your **Netflix** and **Crunchyroll** watch history automatically to [Trakt.tv](https://trakt.tv).

It is a privacy-focused, "Bring Your Own Key" (BYOK) application. You provide your own API credentials, ensuring you have full control over your data and rate limits.

## Features

- **Automatic Scrobbling**: Syncs what you're watching on Netflix and Crunchyroll to Trakt.
- **Instant Identification**: Displays a toast notification (popup) when a show or movie is successfully identified.
- **Privacy Focused**: No data is sent to third-party servers other than Trakt and TMDB (for images).
- **Customizable**: Use your own Trakt API App for unlimited personal use.

## Installation

Since this is a developer/personal build, you need to load it as an "Unpacked Extension" in Chrome (or Edge/Brave/Opera).

1. **Download the Code**: Clone this repository or download the ZIP.

    ```bash
    git clone https://github.com/wckdgod/Crunchflix.git
    ```

2. **Open Extensions Page**: Navigate to `chrome://extensions` in your browser.
3. **Enable Developer Mode**: Toggle the switch in the top-right corner.
4. **Load Unpacked**: Click the button and select the folder containing this code (where `manifest.json` is located).

## Configuration (Required)

Before the extension can work, you must provide your own API keys.

1. **Trakt API Keys**:
    - Go to [Trakt.tv API Apps](https://trakt.tv/oauth/applications) and create a new application.
    - **Name**: `CRUNCHFLIX` (or anything you like).
    - **Redirect URI**: `urn:ietf:wg:oauth:2.0:oob`
    - **Permissions**: Check `/scrobble` and `/checkin`.
    - Copy the **Client ID** and **Client Secret**.

2. **TMDB API Key (Optional but Recommended)**:
    - The extension uses TMDB to fetch high-quality poster images.
    - Get a key from [The Movie Database API](https://www.themoviedb.org/documentation/api).

3. **Enter Keys in Crunchflix**:
    - Click the **CRUNCHFLIX** extension icon.
    - Click **"Configure API Keys"** (or go to Extension Details > Extension Options).
    - Paste your keys and click **Save**.

4. **Connect**:
    - Open the extension popup again.
    - Click **"Connect to Trakt"**.
    - Follow the authentication flow.

## Usage Tips

- **Identification**: When a show is identified, a small popup will appear at the bottom of the screen.
- **Troubleshooting**: If a show/movie isn't detected immediately (especially on Netflix), **pause the video and refresh the page**. This forces the content script to re-scan metadata.

## Credits & Sources

- **Universal Trakt Scrobbler**: Logic for extracting Netflix metadata via the `shakti` API. Source: [trakt-tools/universal-trakt-scrobbler](https://github.com/trakt-tools/universal-trakt-scrobbler/tree/master/src).
- **Made with Google Antigravity**: Developed using Google's experimental agentic coding assistant.
- **MAL-AniList-to-Trakt-Migration**: Reference for migration tools by [tnicko1](https://github.com/tnicko1/MAL-AniList-to-Trakt-Migration).
- **Trakt API**: <https://trakt.tv>
- **TMDB**: <https://www.themoviedb.org>

## License

MIT License. See [LICENSE](LICENSE) for details.
