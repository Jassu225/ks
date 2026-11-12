#!/usr/bin/env node
// Turn raw agent-browser test recordings into one short video to review.
//
//   node finish-video.mjs <raw.webm> [<raw-2.webm> …] [--chapters chapters.json …]
//                         [--out review.mp4] [--still-speedup 8] [--read-cps 15]
//
// Several recordings (the parts of one long test) are joined into one review
// video in the order given; pass one --chapters per part, in the same order.
//
// 1. Cuts the still stretches (the agent thinking between actions): runs of
//    unchanged frames play --still-speedup times faster. Title cards keep
//    moving (their progress bar), so they stay whole.
// 2. Keeps reading time: from each transcript line (title card, step note,
//    observation, verdict) the video plays at real speed long enough to read
//    the line (--read-cps characters per second, 2 to 12 s), so a step and
//    the action it describes stay on screen together. A line that would wait
//    for the one before it shows with it as a two-line subtitle, for their
//    combined reading time (at most 15 s).
// 3. With --chapters (the JSON from __ksVideo.chapters()), adds one MP4
//    chapter per title card, at its time in the review video. PASS/FAIL
//    verdicts are added to the title of the chapter they close.
// 4. Writes the WebVTT transcript beside the video (<out>.vtt), for reading
//    and search (IINA and VLC load it as subtitles). It isn't embedded:
//    title-card.js already draws each note as a caption into the recording.
// 5. Prints the review video's length and each chapter's start time.
//
// Needs ffmpeg 7.1+ and ffprobe on PATH (libx264).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function die(msg) {
  console.error(`finish-video: ${msg}`);
  process.exit(1);
}

const USAGE =
  'usage: finish-video.mjs <raw.webm> [<raw-2.webm> …] [--chapters chapters.json …] [--out review.mp4] [--still-speedup 8] [--read-cps 15]';

function parseArgs(argv) {
  const opts = { inputs: [], chapters: [], out: null, stillSpeedup: 8, readCps: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chapters') opts.chapters.push(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--still-speedup') opts.stillSpeedup = Number(argv[++i]);
    else if (a === '--read-cps') opts.readCps = Number(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('--')) die(`unknown option ${a}`);
    else opts.inputs.push(a);
  }
  if (!opts.inputs.length) die(`no input video\n${USAGE}`);
  for (const f of [...opts.inputs, ...opts.chapters]) if (!fs.existsSync(f)) die(`not found: ${f}`);
  if (opts.chapters.length && opts.chapters.length !== opts.inputs.length) {
    die(`give one --chapters per recording, in the same order (${opts.inputs.length} recordings, ${opts.chapters.length} --chapters)`);
  }
  if (!Number.isInteger(opts.stillSpeedup) || opts.stillSpeedup < 1) die('--still-speedup must be a whole number >= 1');
  if (!(opts.readCps > 0)) die('--read-cps must be a positive number');
  if (!opts.out) {
    const p = path.parse(opts.inputs[0]);
    opts.out = path.join(p.dir, `${p.name.replace(/[.-]raw(-\d+)?$|-\d+$/, '').replace(/^raw(-\d+)?$/, 'raw')}-review.mp4`);
  }
  return opts;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} failed:\n${(r.stderr || '').split('\n').slice(-15).join('\n')}`);
  return r;
}

function frameRate(input) {
  const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,avg_frame_rate', '-of', 'json', input]);
  const s = JSON.parse(r.stdout).streams?.[0] ?? {};
  for (const v of [s.r_frame_rate, s.avg_frame_rate]) {
    const [n, d] = String(v || '').split('/').map(Number);
    const fps = d ? n / d : n;
    if (fps > 0 && fps <= 120) return Math.round(fps);
  }
  return 30;
}

const showinfoTimes = (stderr) =>
  [...stderr.matchAll(/Parsed_showinfo.*?pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));

const fmt = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const vttTime = (sec) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

// ffmetadata escaping: '=', ';', '#', '\' and newlines take a backslash.
const metaEsc = (v) => String(v).replace(/[=;#\\\n]/g, (c) => `\\${c}`);

const opts = parseArgs(process.argv.slice(2));
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ks-video-'));
const readTime = (text) => Math.min(12, Math.max(2, text.length / opts.readCps));

// Transcript lines of one part, on its raw recording's timeline (seconds).
function readLines(chaptersFile) {
  if (!chaptersFile) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
  } catch (e) {
    die(`can't read ${chaptersFile}: ${e.message}`);
  }
  const entries = [...(data.chapters || [])].sort((a, b) => a.t - b.t);
  const t0 = data.t0 ?? entries[0]?.t;
  const lines = [];
  for (const e of entries) {
    const at = Math.max(0, (e.t - t0) / 1000);
    let text = '';
    let label = '';
    if (e.kind === 'verdict') text = `${e.pass ? 'PASS' : 'FAIL'}${e.note ? `: ${e.note}` : ''}`;
    else if (e.kind === 'note') text = e.text || '';
    else {
      label = [e.step, e.title].filter(Boolean).join(' · ') || 'Chapter';
      text = e.subtitle ? `${label}: ${e.subtitle}` : label;
    }
    text = text.replace(/-->/g, '→').replace(/\s*\n+\s*/g, ' ').trim();
    if (text) lines.push({ ...e, label, at, text, read: readTime(text) });
  }
  return lines;
}

// Subtitles: a line that would have to wait for the one before it is shown
// together with it, two lines at once, for their combined reading time (at
// most 15 s). Pairing keeps lines on screen longer and keeps the narration
// close to the action; whatever still overlaps is queued after the pair.
function toSubtitles(lines) {
  const subtitles = [];
  let readUntil = 0;
  for (let i = 0; i < lines.length; ) {
    const first = lines[i];
    const at = Math.max(first.at, readUntil);
    const group = [first];
    const next = lines[i + 1];
    if (next && next.at < at + first.read) group.push(next);
    const chars = group.reduce((n, l) => n + l.text.length, 0);
    const read = Math.min(group.length > 1 ? 15 : 12, Math.max(2, chars / opts.readCps));
    subtitles.push({ at, read, text: group.map((l) => l.text).join('\n') });
    readUntil = at + read;
    i += group.length;
  }
  return subtitles;
}

// One part: cut its stills (keeping cards and reading windows) into an MP4,
// and return its chapters and transcript cues on that MP4's timeline.
function cutPart(input, chaptersFile, n) {
  const fps = frameRate(input);
  const half = 0.5 / fps;
  const lines = readLines(chaptersFile);
  const subtitles = toSubtitles(lines);

  // Pass 1: which frames change (mpdecimate), on the raw timeline. max=N keeps
  // one frame after every N dropped, so stills play N+1x faster.
  const analysis = run('ffmpeg', ['-hide_banner', '-i', input, '-an', '-vf', `mpdecimate=max=${opts.stillSpeedup - 1},showinfo`, '-f', 'null', '-']);
  const changed = showinfoTimes(analysis.stderr);
  if (!changed.length) die(`no frames in ${input} (is it empty?)`);

  // Keep: every changed frame, plus every frame inside a subtitle's reading window.
  const ranges = changed.map((t) => [t - half, t + half]);
  for (const s of subtitles) ranges.push([s.at - half, s.at + s.read]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + half) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }

  // Pass 2: encode the kept frames.
  const cut = path.join(tmp, `cut-${n}.mp4`);
  const select = merged.map(([a, b]) => `between(t,${Math.max(0, a).toFixed(4)},${b.toFixed(4)})`).join('+');
  const filterFile = path.join(tmp, `filter-${n}.txt`);
  fs.writeFileSync(filterFile, `select='${select}',showinfo,setpts=N/(${fps}*TB),scale=trunc(iw/2)*2:trunc(ih/2)*2`);
  const encoded = run('ffmpeg', [
    '-hide_banner', '-y', '-i', input, '-an', '-/filter:v', filterFile, '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', cut,
  ]);
  const kept = showinfoTimes(encoded.stderr);
  if (!kept.length) die(`no frames of ${input} survived the cut`);
  const length = kept.length / fps;

  // Raw time → time in this part's cut: the first kept frame at or after it.
  const toCut = (t) => {
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kept[mid] < t - half) lo = mid + 1;
      else hi = mid;
    }
    return lo / fps;
  };

  // Chapters: a card's starts where the card appeared.
  const chapters = [];
  for (const l of lines) {
    if (l.kind === 'card') chapters.push({ start: toCut(l.at), title: l.label });
    else if (l.kind === 'verdict' && chapters.length) chapters[chapters.length - 1].verdict = l.pass ? 'PASS' : 'FAIL';
  }
  const cues = subtitles.map((s) => {
    const start = toCut(s.at);
    return { start, end: Math.max(Math.min(toCut(s.at + s.read), length), start + 0.1), text: s.text };
  });
  return { cut, length, rawLength: changed[changed.length - 1], chapters, cues };
}

// --- Cut every part, then lay them end to end ------------------------------
const parts = opts.inputs.map((input, n) => cutPart(input, opts.chapters[n], n + 1));
const chapters = [];
const cues = [];
let offset = 0;
parts.forEach((p, n) => {
  const partChapters = p.chapters.map((c) => ({ ...c, start: c.start + offset }));
  if (parts.length > 1 && (!partChapters.length || partChapters[0].start > offset + 0.5)) {
    partChapters.unshift({ start: offset, title: `Part ${n + 1}` });
  }
  chapters.push(...partChapters);
  cues.push(...p.cues.map((c) => ({ ...c, start: c.start + offset, end: c.end + offset })));
  offset += p.length;
});
const reviewLength = offset;
const rawLength = parts.reduce((s, p) => s + p.rawLength, 0);
if (chapters.length && chapters[0].start > 0.5) chapters.unshift({ start: 0, title: 'Start' });
if (chapters.length) chapters[0].start = 0;

let video = parts[0].cut;
if (parts.length > 1) {
  const list = path.join(tmp, 'parts.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.cut.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  video = path.join(tmp, 'joined.mp4');
  run('ffmpeg', ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
}

// --- Transcript (VTT) -------------------------------------------------------
let vtt = null;
if (cues.length) {
  const blocks = ['WEBVTT', ''];
  cues.forEach((c, i) => blocks.push(String(i + 1), `${vttTime(c.start)} --> ${vttTime(c.end)}`, c.text, ''));
  vtt = path.join(path.dirname(opts.out), `${path.parse(opts.out).name}.vtt`);
  fs.writeFileSync(vtt, blocks.join('\n'));
}

// --- Final mux: video + chapters (ffmetadata) + transcript (mov_text) ------
const args = ['-hide_banner', '-y', '-i', video];
const maps = ['-map', '0:v'];
let input = 1;
if (chapters.length) {
  const meta = [';FFMETADATA1', `title=${metaEsc(path.parse(opts.out).name)}`];
  chapters.forEach((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].start : reviewLength;
    const title = c.verdict ? `${c.title} [${c.verdict}]` : c.title;
    meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round(Math.max(end, c.start + 0.001) * 1000)}`, `title=${metaEsc(title)}`);
  });
  const metaFile = path.join(tmp, 'chapters.txt');
  fs.writeFileSync(metaFile, `${meta.join('\n')}\n`);
  args.push('-f', 'ffmetadata', '-i', metaFile);
  maps.push('-map_metadata', String(input), '-map_chapters', String(input));
  input++;
}
// No subtitle track: the captions are already drawn into the picture, and
// ffmpeg's MP4 writer turns any subtitle track on, which would show them twice.
args.push(...maps, '-c:v', 'copy', '-movflags', '+faststart', opts.out);
run('ffmpeg', args);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`review video: ${opts.out}`);
if (vtt) console.log(`transcript: ${vtt}`);
console.log(`length: ${fmt(reviewLength)} (raw ${fmt(rawLength)} in ${parts.length} part${parts.length > 1 ? 's' : ''}, stills ${opts.stillSpeedup}x faster outside reading time)`);
for (const c of chapters) console.log(`  ${fmt(c.start)}  ${c.title}${c.verdict ? `  [${c.verdict}]` : ''}`);
