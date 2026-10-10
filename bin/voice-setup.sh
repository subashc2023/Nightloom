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
# Every download is pinned (item 246 review F2, wave 4): the Hugging Face
# files by a commit hash in the URL, not the moving `main` branch, and the
# whisper.cpp tarball, the two models, the Piper wheel and the voice by
# sha256, checked before the file is used. A mismatch stops the script and
# keeps nothing. A model or voice with no pinned hash below is refused. The
# PyPI dependencies pip pulls for the wheel (onnxruntime, pathvalidate) are
# not pinned by this script.
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
default_models="base.en small.en"
read -r -a models <<<"${NIGHTLOOM_VOICE_MODELS:-$default_models}"
# A value of only spaces reads as no model at all; treat it like an empty or
# unset one (macOS's bash 3.2 aborts on an empty array under set -u).
(( ${#models[@]} )) || read -r -a models <<<"$default_models"
read -r -a cmake_extra <<<"${WHISPER_CMAKE_ARGS:-}"
check_only=0

# Pins. Hugging Face commits: ggerganov/whisper.cpp at 2024-10-29,
# rhasspy/piper-voices at 2026-09-17. Hashes are those Hugging Face and
# GitHub list for each file, checked against the copies on the Mac
# (fetched 2026-09-30) and a fresh download on 2026-10-08.
whisper_models_rev="5359861c739e955e79d9a303bcbc70fb988958b1"
piper_voices_rev="c10ece1aade47bb51c153c893d14e5bf8e5b7117"
whisper_tar_sha256="57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae"
model_sha256() {
  case "$1" in
    base.en) echo a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002 ;;
    small.en) echo c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d ;;
  esac
}
wheel_sha256() {
  case "$1" in
    macosx_11_0_arm64) echo 33e7425933e9290fe651ae127916ed1ca6104cfa3d94e9049295dd3a5c449382 ;;
    macosx_10_9_x86_64) echo 98c7dd791b2be0f8732e5c9cefd86c54200ac0360e43c643c937bf18ac0e941a ;;
    manylinux_2_17_x86_64.*) echo 25b4d3f31ff70c8fa7151908e00aaa5650cbdf16bca8fcf21299f3941b89a7d3 ;;
    manylinux_2_17_aarch64.*) echo 3f60c1917de6d8e8033f395878ad3f88f6dfee88a8b05f98971a275f76a38484 ;;
  esac
}
# voice name -> "<path in piper-voices> <onnx sha256> <onnx.json sha256>"
voice_pin() {
  case "$1" in
    en_US-lessac-medium) echo "en/en_US/lessac/medium" \
      5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f \
      efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0 ;;
  esac
}
[[ "${1:-}" == "--check" ]] && check_only=1

say_() { printf 'voice-setup: %s\n' "$*"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch URL DEST SHA256: download to DEST.part, check, then move into place.
fetch() {
  local url="$1" dest="$2" want="$3" got
  curl -fL --progress-bar -o "$dest.part" "$url"
  got="$(sha256_of "$dest.part")"
  if [[ "$got" != "$want" ]]; then
    rm -f "$dest.part"
    say_ "sha256 mismatch for $url: expected $want, got $got; nothing kept"
    exit 1
  fi
  mv "$dest.part" "$dest"
}

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
    fetch "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$whisper_tag.tar.gz" \
      "$src/whisper.tar.gz" "$whisper_tar_sha256"
    tar xzf "$src/whisper.tar.gz" -C "$src" --strip-components 1
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
    want="$(model_sha256 "$m")"
    if [[ -z "$want" ]]; then
      say_ "no pinned sha256 for the whisper model $m; add it to model_sha256 in this script"
      exit 1
    fi
    say_ "fetching the whisper model $m"
    fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/$whisper_models_rev/ggml-$m.bin" "$f" "$want"
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
  tmp="$(mktemp -d)"
  fetch "https://github.com/OHF-Voice/piper1-gpl/releases/download/v$piper_version/$wheel" \
    "$tmp/$wheel" "$(wheel_sha256 "$tag")"
  python3 -m venv "$dir/piper"
  "$dir/piper/bin/python3" -m pip install --quiet --disable-pip-version-check "$tmp/$wheel"
  rm -rf "$tmp"
fi

# 4. The voice.
if [[ ! -s "$dir/voices/$voice.onnx" || ! -s "$dir/voices/$voice.onnx.json" ]]; then
  pin="$(voice_pin "$voice")"
  if [[ -z "$pin" ]]; then
    say_ "no pinned sha256 for the Piper voice $voice; add it to voice_pin in this script"
    exit 1
  fi
  read -r vpath vsha vjsha <<<"$pin"
  base="https://huggingface.co/rhasspy/piper-voices/resolve/$piper_voices_rev/$vpath/$voice"
  say_ "fetching the Piper voice $voice"
  fetch "$base.onnx" "$dir/voices/$voice.onnx" "$vsha"
  fetch "$base.onnx.json" "$dir/voices/$voice.onnx.json" "$vjsha"
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
