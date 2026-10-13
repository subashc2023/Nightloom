//! 16-bit mono PCM WAV, the one format both ends speak: whisper-server
//! reads it, Piper writes it, and the phone decodes it with
//! `decodeAudioData` with no codec question on iOS (design §2.3).

/// A WAV file's bytes for `pcm` at `rate`.
pub fn encode(pcm: &[i16], rate: u32) -> Vec<u8> {
    let data_len = (pcm.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        b.extend_from_slice(&s.to_le_bytes());
    }
    b
}

/// A 16-bit mono PCM WAV's rate and samples; `None` for anything else.
/// Walks the chunks, so a `LIST` chunk before `data` (ffmpeg writes one)
/// is skipped rather than read as audio.
pub fn decode(bytes: &[u8]) -> Option<(u32, Vec<i16>)> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut i = 12;
    let mut rate = None;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().ok()?) as usize;
        let body = bytes.get(i + 8..(i + 8 + len).min(bytes.len()))?;
        if id == b"fmt " {
            if body.len() < 16 {
                return None;
            }
            let format = u16::from_le_bytes([body[0], body[1]]);
            let channels = u16::from_le_bytes([body[2], body[3]]);
            let bits = u16::from_le_bytes([body[14], body[15]]);
            if format != 1 || channels != 1 || bits != 16 {
                return None;
            }
            rate = Some(u32::from_le_bytes(body[4..8].try_into().ok()?));
        } else if id == b"data" {
            let pcm = body
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| i16::from_le_bytes(*c))
                .collect();
            return Some((rate?, pcm));
        }
        i += 8 + len + (len & 1);
    }
    None
}

/// Samples from little-endian 16-bit bytes, as the phone sends them. An
/// odd trailing byte is dropped.
pub fn samples(bytes: &[u8]) -> impl Iterator<Item = i16> + '_ {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| i16::from_le_bytes(*c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wav_round_trips_and_other_formats_are_refused() {
        let pcm = vec![0i16, 1, -1, i16::MAX, i16::MIN];
        let wav = encode(&pcm, 16_000);
        assert_eq!(wav.len(), 44 + 10);
        assert_eq!(decode(&wav), Some((16_000, pcm)));
        assert_eq!(decode(b"not a wav at all"), None);
        let mut stereo = encode(&[0, 0], 8_000);
        stereo[22] = 2;
        assert_eq!(decode(&stereo), None);
    }
}
