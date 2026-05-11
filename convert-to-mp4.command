#!/bin/bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: ./convert-to-mp4.command <input.webm> [small|balanced|high|4k] [output.mp4]"
  exit 1
fi

INPUT="$1"
PRESET="${2:-balanced}"
OUTPUT="${3:-}"

if [ ! -f "$INPUT" ]; then
  echo "Input file not found: $INPUT"
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found in PATH. Install with: brew install ffmpeg"
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffprobe not found in PATH. Install with: brew install ffmpeg"
  exit 1
fi

if [ -z "$OUTPUT" ]; then
  base="${INPUT%.*}"
  OUTPUT="${base}.mp4"
fi

case "${PRESET,,}" in
  small)
    SCALE="1280:-2"
    CRF="26"
    ENCODE_PRESET="veryfast"
    AUDIO_BITRATE="96k"
    ;;
  balanced)
    SCALE="1920:-2"
    CRF="23"
    ENCODE_PRESET="veryfast"
    AUDIO_BITRATE="128k"
    ;;
  high)
    SCALE="2560:-2"
    CRF="20"
    ENCODE_PRESET="faster"
    AUDIO_BITRATE="160k"
    ;;
  4k)
    SCALE="3840:-2"
    CRF="20"
    ENCODE_PRESET="faster"
    AUDIO_BITRATE="192k"
    ;;
  *)
    echo "Invalid preset: $PRESET. Use one of: small, balanced, high, 4k"
    exit 1
    ;;
esac

if ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=nw=1:nk=1 "$INPUT" | grep -qi audio; then
  AUDIO_ARGS=(-c:a aac -b:a "$AUDIO_BITRATE")
else
  AUDIO_ARGS=(-an)
fi

echo "Converting to MP4..."
echo "Input : $INPUT"
echo "Output: $OUTPUT"
echo "Preset: ${PRESET,,}"

ffmpeg -y -i "$INPUT" \
  -vf "scale='min(${SCALE},iw)':-2" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p \
  -preset "$ENCODE_PRESET" -crf "$CRF" -movflags +faststart \
  "${AUDIO_ARGS[@]}" \
  "$OUTPUT"

echo "Done: $OUTPUT"
