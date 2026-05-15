# DreamRec (WebM Only)

DreamRec is a Chrome extension for reliable tab/screen recording with WebM output.

## Current Scope
- Record screen/tab with audio (system/tab + mic merge when available)
- Resolution options: 720p, 1080p, 1440p, 2160p, Max
- FPS options: 30, 60
- Quality options: High, Medium, Low
- Output: WebM only

## Files
- popup UI: `popup.html`, `popup.js`, `popup.css`
- recorder page: `recorder-page.html`, `recorder-page.js`
- background download bridge: `background.js`
- extension config: `manifest.json`

## Notes
- MP4 conversion pipeline has been removed for now.
- Recorder tab is currently kept open after stop in debug mode.
