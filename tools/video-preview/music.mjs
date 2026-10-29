import fs from 'node:fs';

// An original 120 BPM instrumental loop. No external samples or music service required.
export function writeUpbeatMusic(file, duration = 184) {
  const rate = 32000,
    frames = Math.ceil(duration * rate),
    pcm = new Int16Array(frames * 2);
  const mix = new Float32Array(frames * 2);
  let seed = 7719;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const noteHz = (note) => 440 * 2 ** ((note - 69) / 12);
  const add = (time, length, frequency, gain, kind = 'pluck', pan = 0) => {
    const start = Math.round(time * rate),
      n = Math.round(length * rate);
    for (let j = 0; j < n && start + j < frames; j++) {
      const t = j / rate,
        env =
          Math.min(1, t / 0.006) *
          Math.exp((-t * (kind === 'bass' ? 5 : 7)) / length) *
          Math.min(1, (length - t) / 0.035);
      const wave =
        Math.sin(2 * Math.PI * frequency * t) +
        0.22 * Math.sin(4 * Math.PI * frequency * t);
      const value = wave * env * gain;
      mix[(start + j) * 2] += value * (1 - pan * 0.4);
      mix[(start + j) * 2 + 1] += value * (1 + pan * 0.4);
    }
  };
  const chords = [
    [48, 60, 64, 67],
    [43, 59, 62, 67],
    [45, 60, 64, 69],
    [41, 60, 65, 69]
  ];
  const melody = [0, 2, 1, 2, 0, 1, 2, 1, 2, 1, 0, 2, 1, 2, 0, 1];
  for (let beat = 0; beat * 0.5 < duration; beat++) {
    const chord = chords[Math.floor(beat / 8) % chords.length],
      time = beat * 0.5;
    add(time, 0.42, noteHz(chord[0]), 0.17, 'bass');
    if (beat % 2 === 0)
      for (let c = 1; c < 4; c++)
        add(time + 0.25, 0.32, noteHz(chord[c]), 0.085, 'pluck', (c - 2) * 0.7);
    const index = melody[beat % melody.length];
    if (beat % 8 !== 7) {
      add(
        time + 0.02,
        0.3,
        noteHz(chord[index + 1] + 12),
        0.075,
        'pluck',
        0.45
      );
      add(
        time + 0.27,
        0.18,
        noteHz(chord[((index + 1) % 3) + 1] + 12),
        0.04,
        'pluck',
        -0.45
      );
    }
    for (
      let j = 0;
      j < rate * 0.15 && Math.round(time * rate) + j < frames;
      j++
    ) {
      const t = j / rate,
        kick =
          Math.sin(2 * Math.PI * (43 * t + 6 * (1 - Math.exp(-t * 35)))) *
          Math.exp(-t * 28) *
          0.3;
      const snare = beat % 2 ? noise() * Math.exp(-t * 35) * 0.13 : 0;
      const frame = Math.round(time * rate) + j;
      mix[frame * 2] += kick + snare;
      mix[frame * 2 + 1] += kick + snare;
    }
    for (const offset of [0, 0.25])
      for (
        let j = 0;
        j < rate * 0.045 && Math.round((time + offset) * rate) + j < frames;
        j++
      ) {
        const frame = Math.round((time + offset) * rate) + j,
          hat = noise() * Math.exp((-j / rate) * 100) * 0.035;
        mix[frame * 2] += hat;
        mix[frame * 2 + 1] += hat;
      }
  }
  for (let i = 0; i < mix.length; i++)
    pcm[i] = Math.round(Math.tanh(mix[i] * 1.45) * 23000);
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer)]));
}
