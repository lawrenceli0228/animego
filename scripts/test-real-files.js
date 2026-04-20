#!/usr/bin/env node
/**
 * E2E test: exercises the fixed match pipeline against real fansub files.
 *
 * For each sample we:
 *  1) Compute MD5 of first 16MB (same as client's md5.worker.js)
 *  2) Call dandanplay /api/v2/match (matches server's matchCombined)
 *  3) Apply our controller Phase 1 gate (isMatched OR title-loose-match)
 *  4) Fetch /api/v2/bangumi/{animeId} and run buildEpisodeMap
 *  5) Print whether episode map is non-empty (i.e. danmaku would load)
 *
 * Covers every folder in /Volumes/T7 Shield/DandanPlay foler, including:
 *  - S2/S3/S4 continuation seasons (raw numbers offset: 13-24, 29-38, etc.)
 *  - Fansubs that renumber continuation seasons 1..12 (Oshi no Ko S3 fixture)
 *  - S1 baseline (pure-number level-1 match)
 *  - Triple-bracket naming ([Group][Title][Ep])
 *  - Movies
 */

require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildEpisodeMap } = require('../server/utils/episodeMap');

const TEST_DIR = '/Volumes/T7 Shield/DandanPlay foler';
const EXTRA_DIR = '/Users/lawrence_li/Movies';
const APP_ID = process.env.DANDANPLAY_APP_ID;
const APP_SECRET = process.env.DANDANPLAY_APP_SECRET;
const BASE_URL = 'https://api.dandanplay.net';

const headers = {
  'X-AppId': APP_ID,
  'X-AppSecret': APP_SECRET,
  'Content-Type': 'application/json',
};

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\[\]【】()《》「」『』,.\-_~!@#$%^&*+=|\\/:;?'"]/g, '');
}

function titleLooselyMatchesKeyword(animeTitle, keyword) {
  const a = normalizeTitle(animeTitle);
  const k = normalizeTitle(keyword);
  if (!a || !k) return false;
  return a.includes(k) || k.includes(a);
}

function hash16MB(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const chunkSize = 16 * 1024 * 1024;
  const stat = fs.fstatSync(fd);
  const size = Math.min(chunkSize, stat.size);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, 0);
  fs.closeSync(fd);
  return { hash: crypto.createHash('md5').update(buf).digest('hex'), fileSize: stat.size };
}

function extractKeyword(fileName) {
  let s = fileName.replace(/\.(mkv|mp4)$/i, '');
  // Strip ALL leading [tags] (some files have [Group][Sub] double prefix)
  while (/^\[[^\]]+\]\s*/.test(s)) s = s.replace(/^\[[^\]]+\]\s*/, '');
  // Triple-bracket: [Comicat][Title][13] → title is the first surviving [...]
  const triple = s.match(/^\[([^\]]+)\]/);
  if (triple) s = triple[1];
  // Strip trailing tags like [1080P][XXX]
  s = s.replace(/\s*\[[^\]]+\].*$/g, '');
  // Strip episode markers
  s = s.replace(/\s*-\s*\[?[\d\-\s]+\]?\s*$/, '');
  s = s.replace(/\s*-\s*\d+v?\d*\s*$/i, '');
  s = s.replace(/\s*\(\d{4}\)\s*/, ' ');
  return s.trim();
}

function extractEpisode(fileName) {
  const m = fileName.match(/\s-\s(\d{1,3})v?\d*\s/)
    || fileName.match(/\]\[(\d{1,3})\]/)
    || fileName.match(/\[(\d{1,3})\]/);
  return m ? parseInt(m[1], 10) : 1;
}

async function matchCombined(fileName, fileHash, fileSize) {
  const body = { fileName };
  if (fileHash) body.fileHash = fileHash;
  if (fileSize) body.fileSize = fileSize;
  const res = await fetch(`${BASE_URL}/api/v2/match`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.matches?.length) return { isMatched: false };
  const best = data.matches[0];
  return {
    isMatched: !!data.isMatched,
    animeId: best.animeId,
    animeTitle: best.animeTitle,
    episodeId: best.episodeId,
    episodeTitle: best.episodeTitle,
  };
}

async function fetchEpisodes(animeId) {
  const res = await fetch(`${BASE_URL}/api/v2/bangumi/${animeId}`, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.bangumi) return null;
  return (data.bangumi.episodes || []).map(ep => ({
    dandanEpisodeId: ep.episodeId,
    title: ep.episodeTitle,
    rawEpisodeNumber: ep.episodeNumber || '',
    number: /^\d+$/.test(ep.episodeNumber) ? parseInt(ep.episodeNumber, 10) : null,
  }));
}

async function testFile(filePath, requestedEp, overrideKeyword) {
  const fileName = path.basename(filePath);
  const keyword = overrideKeyword || extractKeyword(fileName);
  const ep = requestedEp || extractEpisode(fileName);
  const result = { fileName, keyword, ep, verdict: '', detail: '' };

  try {
    const { hash, fileSize } = hash16MB(filePath);
    const combined = await matchCombined(fileName, hash, fileSize);
    result.apiIsMatched = combined?.isMatched ?? false;
    result.apiAnimeTitle = combined?.animeTitle ?? null;
    result.apiAnimeId = combined?.animeId ?? null;

    const accept = combined && (
      combined.isMatched ||
      (combined.animeId && titleLooselyMatchesKeyword(combined.animeTitle, keyword))
    );
    result.phase1Accepted = !!accept;
    if (!accept) {
      result.verdict = 'PHASE1_REJECTED';
      return result;
    }

    const episodes = await fetchEpisodes(combined.animeId);
    if (!episodes?.length) {
      result.verdict = 'NO_EPISODES';
      return result;
    }
    result.rawRange = `${episodes[0].rawEpisodeNumber}..${episodes[episodes.length - 1].rawEpisodeNumber}`;
    result.totalEps = episodes.length;

    const map = buildEpisodeMap(episodes, [ep]);
    const mapped = map[ep];
    if (!mapped) {
      result.verdict = 'NO_MAP';
      return result;
    }
    result.mappedId = mapped.dandanEpisodeId;
    result.mappedTitle = mapped.title;
    result.verdict = 'OK';
  } catch (err) {
    result.verdict = 'ERROR';
    result.detail = err.message;
  }
  return result;
}

// Every folder/file present on the test drive, grouped by pattern.
const SAMPLES = [
  // ─── S2/S3/S4 continuation seasons (the bug's primary target) ────────
  { label: 'Enen no Shouboutai S3',
    dir: '[LoliHouse] Enen no Shouboutai S3 - [01-12] [WebRip 1080p HEVC-10bit AAC SRTx2]',
    file: '[LoliHouse] Enen no Shouboutai S3 - 05 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv',
    keyword: 'Enen no Shouboutai', ep: 5 },
  { label: 'Kakkou no Iinazuke S2',
    dir: '[LoliHouse] Kakkou no Iinazuke S2 [01-12][WebRip 1080p HEVC-10bit AAC]',
    file: '[LoliHouse] Kakkou no Iinazuke S2 - 03 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv',
    keyword: 'Kakkou no Iinazuke', ep: 3 },
  { label: 'Yofukashi no Uta S2',
    dir: '[LoliHouse] Yofukashi no Uta S2 [01-12][WebRip 1080p HEVC-10bit AAC]',
    file: '[LoliHouse] Yofukashi no Uta S2 - 02v2 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv',
    keyword: 'Yofukashi no Uta', ep: 2 },
  { label: 'Frieren 第二季 (raw 29-38)',
    file: '[ANi] 葬送的芙莉蓮 第二季 - [29-38][1080P][Baha][WEB-DL][AAC AVC][CHT].mp4',
    keyword: '葬送的芙莉蓮', ep: 31 },
  { label: 'Dan Da Dan S2 (raw 13-24)',
    dir: '[Skymoon-Raws] DAN DA DAN - [13-24][CHT][SRT][1080p][AVC AAC]',
    keyword: 'DAN DA DAN', ep: 13 },
  { label: 'Spy x Family S3 (raw 38-)',
    dir: '[云光字幕组] Spy x Family Season 3 [01-12]',
    keyword: 'Spy x Family', ep: 38 },
  { label: 'Tate no Yuusha S4',
    dir: '[Tate no Yuusha no Nariagari S4][01-12][BIG5][720P]',
    keyword: 'Tate no Yuusha no Nariagari', ep: 1 },
  { label: 'Kaijuu 8-gou S2 (raw 13-23)',
    dir: '[LoliHouse] Kaijuu 8-gou [13-23+SP][WebRip 1080p HEVC-10bit AAC]',
    keyword: 'Kaijuu 8-gou', ep: 13 },
  { label: 'Shoushimin Series S2 (raw 11-20)',
    dir: '[MingY] Shoushimin Series [11-20][WebRip][JPCN]',
    keyword: 'Shoushimin Series', ep: 11 },
  { label: 'Uma Musume Cinderella Gray S2 (raw 14-23)',
    dir: '[OguriClub&S1YURICON] Umamusume Cinderella Gray[14-23][1080p][WebRip][HEVC_AAC][CHS_JP]',
    keyword: 'Umamusume Cinderella Gray', ep: 14 },

  // ─── S1 baselines (should hit level-1 pure-number match) ─────────────
  { label: 'Sono Bisque Doll (raw 13-24)',
    file: '[Comicat][Sono Bisque Doll wa Koi o Suru][13][1080P][GB&JP][MP4].mp4',
    keyword: 'Sono Bisque Doll wa Koi o Suru', ep: 13 },
  { label: 'Kaoru Hana wa Rin to Saku',
    file: '[Nekomoe kissaten][Kaoru Hana wa Rin to Saku][03][1080p][JPSC].mp4',
    keyword: 'Kaoru Hana wa Rin to Saku', ep: 3 },
  { label: 'Hibi wa Sugiredo Meshi Umashi',
    dir: '[LoliHouse] Hibi wa Sugiredo Meshi Umashi -[1- 12] [WebRip 1080p HEVC-10bit AAC ASSx2]',
    keyword: 'Hibi wa Sugiredo Meshi Umashi', ep: 1 },
  { label: 'Katainaka no Ossan, Kensei ni Naru',
    dir: '[LoliHouse] Katainaka no Ossan, Kensei ni Naru - [01-12] [WebRip 1080p HEVC-10bit AAC SRTx2]',
    keyword: 'Katainaka no Ossan', ep: 1 },
  { label: 'Uma Musume Cinderella Gray S1',
    dir: '[LoliHouse] Uma Musume Cinderella Gray - [1-13] [WebRip 1080p HEVC-10bit AAC SRTx2]',
    keyword: 'Uma Musume Cinderella Gray', ep: 1 },
  { label: 'One Punch Man (2025)',
    dir: '[Sakurato] One Punch Man (2025) [01-12][AVC-8bit 1080p AAC][CHS]',
    keyword: 'One Punch Man', ep: 1 },
  { label: 'LAZARUS',
    dir: '[Nekomoe kissaten][LAZARUS][01-13][1080p][JPSC]',
    keyword: 'LAZARUS', ep: 1 },
  { label: 'Zatsu Tabi',
    dir: '[Nekomoe kissaten][Zatsu Tabi][01-12][1080p][JPSC]',
    keyword: 'Zatsu Tabi', ep: 1 },
  { label: 'mono女孩',
    dir: '[ANi] mono女孩 - [1-12] [1080P][Baha][WEB-DL][AAC AVC][CHT]',
    keyword: 'mono女孩', ep: 1 },
  { label: 'Can a Boy-Girl Friendship Survive',
    dir: '[KTXP][Can_a_Boy-Girl_Friendship_Survive][1-12][GB_CN][HEVC_opus][1080p]',
    keyword: 'Can a Boy-Girl Friendship Survive', ep: 1 },
  { label: 'Seishun Buta Yarou Santa Claus',
    file: '[Skymoon-Raws] Seishun Buta Yarou wa Santa Claus no Yume wo Minai - 01 [ViuTV][WEB-DL][CHT][SRT][1080p][AVC AAC].mkv',
    keyword: 'Seishun Buta Yarou', ep: 1 },
  { label: 'Mobile Suit Gundam GQuuuuuuX',
    dir: '[SweetSub] Mobile Suit Gundam GQuuuuuuX [01-12][WebRip][1080P][AVC 8bit][CHS]',
    keyword: 'Gundam GQuuuuuuX', ep: 1 },
  { label: 'Oniichan ha Oshimai!',
    dir: '[SweetSub] Oniichan ha Oshimai! [01-12][BDRip][1080P][AVC 8bit][CHT]',
    keyword: 'Oniichan ha Oshimai', ep: 1 },

  // ─── Movies ──────────────────────────────────────────────────────────
  { label: 'Demon Slayer Infinity Castle',
    file: '鬼灭之刃：无限城篇 第一章 猗窝座再袭.Demon.Slayer.Kimetsu.no.Yaiba.The.Movie.Infinity.Castle.2025.1080p.WEBRip.x265.AAC-PorterRAWS.mkv',
    keyword: '鬼灭之刃 无限城', ep: 1 },
  { label: 'Cosmic Princess Kaguya (Movie)',
    file: 'Cosmic.Princess.Kaguya.2026.1080p.NF.WEB-DL.JPN.DDP5.1.H.264-shenghuo2.ZH.mkv',
    keyword: 'Cosmic Princess Kaguya', ep: 1 },
  { label: '超时空辉夜姬 Movie',
    file: '[Pre-S&三明治摸鱼部] 超时空辉夜姬 Cosmic Princess Kaguya [Movie][WebRip 1080P AVC 8Bit AAC MP4][简日内嵌][全歌曲特效][V2].mp4',
    keyword: '超时空辉夜姬', ep: 1 },

  // ─── Original bug fixture (Oshi no Ko S3, raw 25..35 + C1/C2/C3) ─────
  { label: 'Oshi no Ko S3 E11 (original bug)',
    absPath: path.join(EXTRA_DIR, '[LoliHouse] Oshi no Ko S3 - 11 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv'),
    keyword: '我推的孩子 第三季', ep: 11 },
];

async function testManualPick(label, animeId, requestedEps) {
  const episodes = await fetchEpisodes(animeId);
  if (!episodes?.length) return { label, animeId, verdict: 'NO_EPISODES' };
  const rawRange = `${episodes[0].rawEpisodeNumber}..${episodes[episodes.length - 1].rawEpisodeNumber}`;
  const map = buildEpisodeMap(episodes, requestedEps);
  return {
    label, animeId, rawRange, totalEps: episodes.length,
    requestedEps, map,
    verdict: Object.keys(map).length === requestedEps.length ? 'OK' : 'PARTIAL',
  };
}

function resolveSamplePath(s) {
  if (s.absPath) return s.absPath;
  if (s.dir) {
    const dir = path.join(TEST_DIR, s.dir);
    if (!fs.existsSync(dir)) return null;
    const picks = fs.readdirSync(dir)
      .filter(f => /\.(mkv|mp4)$/i.test(f) && !f.startsWith('.'))
      .sort();
    if (s.file) return path.join(dir, s.file);
    return picks.length ? path.join(dir, picks[0]) : null;
  }
  return path.join(TEST_DIR, s.file);
}

async function main() {
  const results = [];
  for (const s of SAMPLES) {
    const fullPath = resolveSamplePath(s);
    if (!fullPath || !fs.existsSync(fullPath)) {
      results.push({ label: s.label, fileName: s.file || s.dir, verdict: 'FILE_MISSING' });
      continue;
    }
    let actualPath = fullPath;
    if (fs.statSync(actualPath).isDirectory()) {
      const picks = fs.readdirSync(actualPath)
        .filter(f => /\.(mkv|mp4)$/i.test(f) && !f.startsWith('.'))
        .sort();
      if (!picks.length) {
        results.push({ label: s.label, fileName: path.basename(actualPath), verdict: 'NO_VIDEO_IN_DIR' });
        continue;
      }
      actualPath = path.join(actualPath, picks[0]);
    }
    process.stderr.write(`Testing: ${s.label} → ${path.basename(actualPath)}\n`);
    const r = await testFile(actualPath, s.ep, s.keyword);
    r.label = s.label;
    results.push(r);
  }

  console.log('\n=== RESULTS ===\n');
  for (const r of results) {
    const v = r.verdict === 'OK' ? '✅'
            : r.verdict === 'FILE_MISSING' ? '⏭️'
            : '❌';
    console.log(`${v} ${r.label}`);
    console.log(`   file:      ${r.fileName}`);
    if (r.keyword) console.log(`   keyword:   "${r.keyword}"   ep=${r.ep}`);
    if (r.apiAnimeTitle !== undefined) {
      console.log(`   API:       isMatched=${r.apiIsMatched}  candidate="${r.apiAnimeTitle}" (id=${r.apiAnimeId})`);
    }
    if (r.phase1Accepted !== undefined) {
      console.log(`   phase 1:   ${r.phase1Accepted ? 'ACCEPTED' : 'REJECTED'}`);
    }
    if (r.rawRange) console.log(`   eps:       raw ${r.rawRange}  (${r.totalEps} eps)`);
    if (r.mappedId) console.log(`   mapped:    ep ${r.ep} → ${r.mappedId} "${r.mappedTitle}"`);
    console.log(`   verdict:   ${r.verdict}${r.detail ? '  (' + r.detail + ')' : ''}`);
    console.log('');
  }

  const attempted = results.filter(r => r.verdict !== 'FILE_MISSING');
  const ok = attempted.filter(r => r.verdict === 'OK').length;
  const rejected = attempted.filter(r => r.verdict === 'PHASE1_REJECTED').length;
  const noMap = attempted.filter(r => r.verdict === 'NO_MAP').length;
  const missing = results.filter(r => r.verdict === 'FILE_MISSING').length;
  console.log(`Summary: ${ok}/${attempted.length} OK, ${rejected} phase-1 rejected, ${noMap} no-map, ${missing} file-missing\n`);

  // Manual-pick path: exercises client-side selectManual → buildEpisodeMap
  console.log('=== MANUAL PICK PATH (Oshi no Ko S3, id=18901) ===\n');
  const manualTests = [
    { label: 'Oshi no Ko S3 E11 single pick', animeId: 18901, eps: [11] },
    { label: 'Oshi no Ko S3 all 11 eps batched', animeId: 18901, eps: [1,2,3,4,5,6,7,8,9,10,11] },
  ];
  for (const t of manualTests) {
    const r = await testManualPick(t.label, t.animeId, t.eps);
    console.log(`${t.label}`);
    if (r.rawRange) console.log(`  raw range: ${r.rawRange} (${r.totalEps} eps)`);
    for (const ep of t.eps) {
      const m = r.map?.[ep];
      console.log(`  ep ${String(ep).padStart(2)} → ${m ? `${m.dandanEpisodeId} "${m.title}"` : 'UNMAPPED'}`);
    }
    console.log(`  VERDICT: ${r.verdict}\n`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
