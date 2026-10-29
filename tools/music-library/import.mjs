import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    out: { type: 'string', default: 'assets/music' }
  }
});
if (!values.source)
  throw new Error('Usage: npm run music:import -- --source /path/to/Suno合集');
const source = path.resolve(values.source),
  root = path.resolve(values.out);
const groups = [
  ['sunny-departure', '晴天出发', '轻快流行 · 自驾 / 亲子'],
  ['lakeside-stroll', '湖边散步', '清新木吉他 · 公园 / 湖畔'],
  ['city-postcards', '城市明信片', '城市律动 · 街区 / 夜景'],
  ['trail-day', '山野小路', '轻冒险 · 山野 / 徒步'],
  ['eastern-postcards', '江南来信', '现代国风 · 园林 / 古城']
];
const files = fs
  .readdirSync(source)
  .filter((name) => /^\d{2}_.+\.mp3$/i.test(name))
  .sort();
if (files.length !== 10)
  throw new Error('Expected the 10 numbered Suno MP3 files.');
fs.mkdirSync(root, { recursive: true });
const lock = path.join(root, '.import.lock');
const lockHandle = fs.openSync(lock, 'wx');
fs.writeFileSync(
  lockHandle,
  JSON.stringify({
    pid: process.pid,
    source,
    startedAt: new Date().toISOString()
  })
);
const staging = path.join(root, `.import-${randomUUID()}`);
fs.mkdirSync(staging);
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
async function command(binary, args) {
  return run(binary, args, { maxBuffer: 4 * 1024 * 1024 });
}
async function probe(file) {
  const { stdout } = await command('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_name,sample_rate,channels',
    '-of',
    'json',
    file
  ]);
  return JSON.parse(stdout);
}
async function loudness(file) {
  const { stderr } = await command('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-af',
    'loudnorm=I=-16:TP=-2:LRA=11:print_format=json',
    '-f',
    'null',
    '-'
  ]);
  const matches = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g);
  if (!matches?.length) throw new Error('Could not measure music loudness.');
  const stats = JSON.parse(matches.at(-1));
  if (!Number.isFinite(Number(stats.input_i)))
    throw new Error('Silent or invalid audio.');
  return stats;
}
function publish(file, name) {
  const target = path.join(root, name);
  if (!fs.existsSync(target)) fs.renameSync(file, target);
  return target;
}
const tracks = new Array(files.length);
let cursor = 0;
async function worker() {
  while (cursor < files.length) {
    const index = cursor++,
      name = files[index],
      input = path.join(source, name);
    const order = Number(name.slice(0, 2));
    if (order !== index + 1)
      throw new Error('Unexpected source file numbering.');
    const [family, title, mood] = groups[Math.floor(index / 2)],
      version = index % 2 ? 'B' : 'A';
    const sourceHash = hash(fs.readFileSync(input));
    const stats = await loudness(input);
    const output = path.join(staging, `${order}.mp3`);
    const filter = `loudnorm=I=-16:TP=-2:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`;
    await command('ffmpeg', [
      '-v',
      'error',
      '-n',
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-map_metadata',
      '-1',
      '-af',
      filter,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '160k',
      output
    ]);
    const normalized = await loudness(output),
      info = await probe(output);
    const duration = Number(info.format.duration),
      integratedLufs = Number(normalized.input_i),
      truePeakDb = Number(normalized.input_tp);
    if (
      duration < 5 ||
      duration > 1200 ||
      Math.abs(integratedLufs + 16) > 1 ||
      truePeakDb > -1
    )
      throw new Error(`Audio verification failed: ${name}`);
    const sha256 = hash(fs.readFileSync(output)),
      file = `${sha256}.mp3`;
    const preview = path.join(staging, `${order}-preview.mp3`);
    await command('ffmpeg', [
      '-v',
      'error',
      '-n',
      '-i',
      output,
      '-t',
      '20',
      '-map_metadata',
      '-1',
      '-af',
      'afade=t=in:d=0.06,afade=t=out:st=19.2:d=0.8',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      preview
    ]);
    const previewFile = `${hash(fs.readFileSync(preview))}-preview.mp3`;
    const previewInfo = await probe(preview);
    if (Number(previewInfo.format.duration) < 19.9)
      throw new Error('Incomplete music preview.');
    publish(output, file);
    publish(preview, previewFile);
    tracks[index] = {
      id: `${family}-${version.toLowerCase()}-${sourceHash.slice(0, 8)}`,
      title,
      version,
      mood,
      duration,
      file,
      previewFile,
      sha256,
      sourceName: name,
      sourceHash,
      integratedLufs,
      truePeakDb
    };
    console.log(
      `${title} ${version}: ${Math.round(duration)}s, ${integratedLufs} LUFS, ${truePeakDb} dBTP`
    );
  }
}
try {
  const results = await Promise.allSettled([worker(), worker()]);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  const temporary = path.join(staging, 'catalog.json');
  fs.writeFileSync(
    temporary,
    JSON.stringify(
      {
        version: 1,
        importedAt: new Date().toISOString(),
        previewSeconds: 20,
        targetLufs: -16,
        tracks
      },
      null,
      2
    )
  );
  fs.renameSync(temporary, path.join(root, 'catalog.json'));
  console.log(
    `Published ${tracks.length} built-in tracks; source files unchanged.`
  );
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.closeSync(lockHandle);
  fs.unlinkSync(lock);
}
