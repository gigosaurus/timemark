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
| Tap tempo (step 2) | `T`                |

Each action also has an on-screen button. To rebind a shortcut, open **Keyboard shortcuts** in the side panel and click **Change**. The skip amount X defaults to 3 seconds and can be changed in the **Skip** box.

### Other features

- **Speed:** slow playback down (0.25×–2×) to make precise marks easier.
- **Window:** sets how many seconds of waveform are visible for audio files.
- **Auto-label from text:** paste lyrics or a list of scene names, and each new mark takes the next word or line as its label. **Apply to all marks** relabels your existing marks in time order.
- In each timestamp's row, **⤓** moves that mark to the current playback time and **✕** deletes it. Click a time to jump to it.
- Marks are autosaved in your browser (keyed by file name and size), so reopening the same file restores them.

## Step 2: beat grid and snapping

Once your marks are down, switch to **2 · Beat grid & snap** to fine-tune them against the music's tempo. Step 1 doesn't change.

1. **Set the tempo.** Play the track and tap `T` (or the **Tap tempo** button) on each beat, starting on beat 1 of a bar. Taps set both the BPM and where beat 1 falls. Or use **set beat 1 at the playhead** and type the BPM yourself.
2. **Add tempo changes** with **+ Tempo change at playhead**. Each change starts at the beat nearest the playhead, and you can edit its start time, BPM and beats per bar. Each tempo section starts on beat 1 of a bar.
3. **Line up the grid.** Use **Shift grid ±10 ms**, and turn on **Metronome click** to hear the grid against the track.
4. **Choose what to snap to.** Options are beat, ½, ¼ and ⅛ beat, and ⅓ and ⅙ beat (triplets). You can tick any combination, and each mark snaps to whichever ticked line is nearest.
5. **Snap.** On the waveform, dashed lines show where each mark would go. **Snap all marks** moves them all. The **♩** button in a mark's row snaps just that mark. You can also drag a mark on the waveform: it snaps as you drag, and holding `Shift` moves it freely. **Undo change** reverts any of these, as well as tempo edits.

In step 2, video files also show a waveform under the video, so the grid has something to sit on. The tempo map is saved with your marks. The JSON export then includes it, along with each mark's bar and beat.

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
    { "index": 1, "time": 1.094, "timecode": "00:00:01.094", "label": "Never", "bar": 1, "beat": 2.5 }
  ],
  "tempo": [
    { "start": 0.5, "bpm": 120, "beatsPerBar": 4 }
  ]
}
```

`time` is in seconds, with millisecond precision. `bar`, `beat` and `tempo` appear only once a tempo has been set. `beat` is 1-based within the bar, so 2.5 means halfway between beats 2 and 3.

## Tests

The tempo maths (snapping, grid lines, bar/beat positions, tap fitting) lives in `tempo.js` and has unit tests:

```sh
node --test test/*.test.js
```
