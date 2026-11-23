#!/usr/bin/env bash
# Generates the 15 synthetic media files the golden 20-clip project points at.
# Needs ffmpeg (free: `brew install ffmpeg`). 29.97 fps, 1920x1080, 48 kHz.
set -euo pipefail
OUT="${1:-/Users/Shared/Editz Golden/media}"
mkdir -p "$OUT"
R=30000/1001
v() { # name frames with_audio
  local a=(); [ "$3" = 1 ] && a=(-f lavfi -i "sine=frequency=440:sample_rate=48000" -c:a aac -ac 2)
  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=$R" "${a[@]}" \
    -frames:v "$2" -shortest -c:v libx264 -pix_fmt yuv420p -r "$R" "$OUT/$1"
}
au() { # name seconds freq
  ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=$3:sample_rate=48000:duration=$2" -ac 2 -c:a pcm_s16le "$OUT/$1"
}
for i in 1 2 3 4 5; do v "aroll_0$i.mp4" 3600 1; done
for i in 1 2 3 4 5 6; do v "broll_0$i.mp4" 600 0; done
au music_bed.wav 300.3 220
for i in 1 2 3; do au "vo_0$i.wav" 10.01 660; done
echo "Golden media in $OUT"
