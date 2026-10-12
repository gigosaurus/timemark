# Timemark

A lightweight, static web app for marking timestamps in a video or audio file and exporting them as `.txt` or `.json`. You can use it to time every word in a song, or to log scenes in a video.

No build step, no dependencies, no server. Your media file never leaves your browser.

## Running it

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

It also works as-is on GitHub Pages or any static host.

## Using it

1. Drop a video or audio file onto the page, or click **Open file…**.
2. Play it, and press **Mark** (default `Space`) whenever you want a timestamp.
3. Optionally type a label next to each timestamp.
4. Click **Download .txt** or **Download .json**.

Video files are shown as you play them. Audio files show a scrolling waveform with the playhead in the middle. You can click the waveform to jump to a point, or drag it to scrub. The bar under the player shows your position in the whole file, along with every mark. You can click or drag that bar too.

### Keyboard shortcuts (defaults)

| Action          | Keys                  |
|-----------------|-----------------------|
| Go back X s     | `A` or `←`            |
| Play            | `S`                   |
| Pause           | `D`                   |
| Go forward X s  | `F` or `→`            |
| Mark timestamp  | `Space`               |
| Undo last mark  | `Z` or `Backspace`    |

Each action also has an on-screen button. To rebind a shortcut, open **Keyboard shortcuts** in the side panel and click **Change**. The skip amount X defaults to 3 seconds and can be changed in the **Skip** box.

### Other features

- **Speed:** slow playback down (0.25×–2×) to make precise marks easier.
- **Window:** sets how many seconds of waveform are visible for audio files.
- **Auto-label from text:** paste lyrics or a list of scene names, and each new mark takes the next word or line as its label. **Apply to all marks** relabels your existing marks in time order.
- In each timestamp's row, **⤓** moves that mark to the current playback time and **✕** deletes it. Click a time to jump to it.
- Marks are autosaved in your browser (keyed by file name and size), so reopening the same file restores them.

## Export formats

**TXT**: one timestamp per line, with a tab before the label when there is one:

```
00:00:01.094	Never
00:00:01.821	gonna
00:00:02.310
```

**JSON**:

```json
{
  "file": "song.mp3",
  "duration": 213.04,
  "timestamps": [
    { "index": 1, "time": 1.094, "timecode": "00:00:01.094", "label": "Never" }
  ]
}
```

`time` is in seconds, with millisecond precision.
