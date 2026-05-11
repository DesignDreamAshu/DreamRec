# DreamRec

DreamRec is a Chrome extension for recording browser meetings and screens with controllable quality, FPS, output format, and compression mode.

## Features

- One-click recording flow with screen share picker
- Quality presets up to 4K
- FPS selection: 25, 30, 60
- Output format preference: WebM / MP4 (browser-support dependent, with fallback)
- Size/quality modes: Compatibility, Balanced, Small, Ultra Small
- Save As support for custom output path
- Post-conversion scripts for MP4 optimization

## Local Setup

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Open extension popup and start recording

### macOS Permission Setup

Before recording on Mac:

1. Open **System Settings** -> **Privacy & Security** -> **Screen Recording**
2. Enable permission for **Google Chrome**
3. Restart Chrome

## MP4 Conversion (Optional)

Browser recording may still produce WebM depending on runtime codec support.
Use the included converter scripts:

```bat
convert-to-mp4.bat "C:\path\meeting-recording.webm" balanced
```

macOS:

```bash
chmod +x ./convert-to-mp4.command
./convert-to-mp4.command "/path/to/meeting-recording.webm" balanced
```

Available presets: `small`, `balanced`, `high`, `4k`.

## Notes

- If MP4 codec is unsupported at runtime, DreamRec falls back to WebM.
- For guaranteed MP4 everywhere, keep using the FFmpeg conversion script.
