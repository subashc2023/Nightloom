#!/bin/bash
# Fetch the two programs the phone's voice mode runs on the host (item 246,
# wave 3; design notes/research/246-phone-parity-voice-design-2026-09-30.md
# §2.3): whisper.cpp hears, Piper speaks. Everything lands outside the repo,
# in the voice directory the service looks in first:
#
#   ${NIGHTLOOM_HOME:-~/.nightloom}/voice/
#     models/ggml-base.en.bin     whisper, the partials while he talks (~148 MB)
#     models/ggml-small.en.bin    whisper, the final pass after the pause (~488 MB)
#     piper/                      a Python venv holding the piper-tts wheel
#     voices/<voice>.onnx(.json)  the Piper voice (~63 MB)
#     fixtures/*.wav              16 kHz test speech, made with macOS `say`
#
#   bin/voice-setup.sh            fetch what is missing (safe to re-run)
#   bin/voice-setup.sh --check    say what is there, fetch nothing
#
# Sources, and only these (blocker 695 records why models come from Hugging
# Face): whisper.cpp from Homebrew (formula whisper-cpp, which builds
# github.com/ggml-org/whisper.cpp) or, off macOS, that repo's release
# tarball built with cmake; the ggml models from huggingface.co/ggerganov/
# whisper.cpp, the host whisper.cpp's own models/download-ggml-model.sh
# names; the Piper wheel from github.com/OHF-Voice/piper1-gpl releases, its
# one runtime dependency (onnxruntime, and pathvalidate) from PyPI; the voice
# from huggingface.co/rhasspy/piper-voices, the host piper's own
# download_voices.py names. Nothing is fetched from anywhere else.
#
# NIGHTLOOM_VOICE overrides the voice (default en_US-lessac-medium, blocker
# 663's "a Piper US-English medium voice"). NIGHTLOOM_VOICE_MODELS picks the
# whisper models (default "base.en small.en"; the service uses one for both
# passes when only one is there). WHISPER_CMAKE_ARGS adds cmake flags to the
# off-macOS build: the Fly image (deploy/Dockerfile) passes
# -DGGML_NATIVE=OFF so the program does not use the build machine's own CPU
# features, which the machine it runs on may lack.
set -euo pipefail

home="${NIGHTLOOM_HOME:-$HOME/.nightloom}"
dir="$home/voice"
voice="${NIGHTLOOM_VOICE:-en_US-lessac-medium}"
piper_version="1.8.0"
whisper_tag="v1.9.4"
read -r -a models <<<"${NIGHTLOOM_VOICE_MODELS:-base.en small.en}"
read -r -a cmake_extra <<<"${WHISPER_CMAKE_ARGS:-}"
check_only=0
[[ "${1:-}" == "--check" ]] && check_only=1

say_() { printf 'voice-setup: %s\n' "$*"; }

have_whisper_server() {
  [[ -x "$dir/bin/whisper-server" ]] || command -v whisper-server >/dev/null 2>&1
}

status() {
  local ok=1
  if have_whisper_server; then say_ "whisper-server: $(command -v whisper-server || echo "$dir/bin/whisper-server")"; else say_ "whisper-server: missing"; ok=0; fi
  for m in "${models[@]}"; do
    if [[ -s "$dir/models/ggml-$m.bin" ]]; then say_ "model $m: $(du -h "$dir/models/ggml-$m.bin" | cut -f1)"; else say_ "model $m: missing"; ok=0; fi
  done
  if [[ -x "$dir/piper/bin/python3" ]] && "$dir/piper/bin/python3" -c 'import piper' 2>/dev/null; then say_ "piper: $dir/piper"; else say_ "piper: missing"; ok=0; fi
  if [[ -s "$dir/voices/$voice.onnx" && -s "$dir/voices/$voice.onnx.json" ]]; then say_ "voice $voice: present"; else say_ "voice $voice: missing"; ok=0; fi
  return $(( ok ? 0 : 1 ))
}

if (( check_only )); then
  status
  exit $?
fi

mkdir -p "$dir/models" "$dir/voices" "$dir/bin" "$dir/fixtures"

# 1. whisper.cpp's server.
if ! have_whisper_server; then
  if [[ "$(uname)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    say_ "installing whisper.cpp with Homebrew (formula whisper-cpp)"
    brew install whisper-cpp
  elif command -v cmake >/dev/null 2>&1; then
    say_ "building whisper.cpp $whisper_tag from its GitHub release"
    src="$(mktemp -d)"
    curl -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$whisper_tag.tar.gz" \
      | tar xz -C "$src" --strip-components 1
    # Static libraries, so the one program copied out runs without the
    # build tree's libwhisper/libggml shared objects beside it.
    cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_EXAMPLES=ON \
      -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF ${cmake_extra[@]+"${cmake_extra[@]}"} >/dev/null
    cmake --build "$src/build" -j --config Release --target whisper-server >/dev/null
    cp "$src/build/bin/whisper-server" "$dir/bin/whisper-server"
    rm -rf "$src"
  else
    say_ "no Homebrew and no cmake: install whisper.cpp's whisper-server yourself, or put it in $dir/bin"
    exit 1
  fi
fi

# 2. The ggml models.
for m in "${models[@]}"; do
  f="$dir/models/ggml-$m.bin"
  if [[ ! -s "$f" ]]; then
    say_ "fetching the whisper model $m"
    curl -fL --progress-bar -o "$f.part" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$m.bin"
    mv "$f.part" "$f"
  fi
done

# 3. Piper, in its own venv so nothing touches the system Python.
if ! { [[ -x "$dir/piper/bin/python3" ]] && "$dir/piper/bin/python3" -c 'import piper' 2>/dev/null; }; then
  case "$(uname)-$(uname -m)" in
    Darwin-arm64) tag="macosx_11_0_arm64" ;;
    Darwin-x86_64) tag="macosx_10_9_x86_64" ;;
    Linux-x86_64) tag="manylinux_2_17_x86_64.manylinux2014_x86_64.manylinux_2_28_x86_64" ;;
    Linux-aarch64) tag="manylinux_2_17_aarch64.manylinux2014_aarch64.manylinux_2_28_aarch64" ;;
    *) say_ "no Piper wheel for $(uname)-$(uname -m)"; exit 1 ;;
  esac
  wheel="piper_tts-$piper_version-cp39-abi3-$tag.whl"
  say_ "installing Piper $piper_version from its GitHub release"
  python3 -m venv "$dir/piper"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$wheel" \
    "https://github.com/OHF-Voice/piper1-gpl/releases/download/v$piper_version/$wheel"
  "$dir/piper/bin/python3" -m pip install --quiet --disable-pip-version-check "$tmp/$wheel"
  rm -rf "$tmp"
fi

# 4. The voice.
if [[ ! -s "$dir/voices/$voice.onnx" || ! -s "$dir/voices/$voice.onnx.json" ]]; then
  say_ "fetching the Piper voice $voice"
  "$dir/piper/bin/python3" -m piper.download_voices --data-dir "$dir/voices" "$voice"
fi

# 5. Test speech for the integration test (macOS only: `say` is the stand-in
#    for a human voice; a different engine from Piper on purpose).
if [[ "$(uname)" == "Darwin" ]] && command -v say >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
  mk() {
    local name="$1" text="$2"
    if [[ ! -s "$dir/fixtures/$name.wav" ]]; then
      say -o "$dir/fixtures/$name.aiff" "$text"
      ffmpeg -loglevel error -y -i "$dir/fixtures/$name.aiff" -ar 16000 -ac 1 -c:a pcm_s16le "$dir/fixtures/$name.wav"
      rm -f "$dir/fixtures/$name.aiff"
    fi
  }
  mk weather "What's the weather like on the away server?"
  mk walk "Remind me what we decided about the phone's voice mode, and keep it short."
  printf '%s\n' "What's the weather like on the away server?" > "$dir/fixtures/weather.txt"
  printf '%s\n' "Remind me what we decided about the phone's voice mode, and keep it short." > "$dir/fixtures/walk.txt"
fi

status
