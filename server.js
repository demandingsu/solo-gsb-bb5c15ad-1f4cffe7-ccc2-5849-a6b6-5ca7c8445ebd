'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');

const { parseSrt, serializeSrt } = require('./src/srt');
const { parseFlexibleTime } = require('./src/time');
const { DEFAULTS, fixSubtitles } = require('./src/fixer');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
});

app.use(express.static(path.join(__dirname, 'public')));

function parseNumberField(value, name, { min, max, integer = false, fallback }) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的数字。`);
  }
  if (integer && !Number.isInteger(number)) {
    throw new Error(`${name} 必须是整数。`);
  }
  return number;
}

function parseCuts(text) {
  const pieces = String(text ?? '')
    .split(/[\n,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const cuts = pieces.map(parseFlexibleTime);
  const uniqueSorted = [...new Set(cuts)].sort((a, b) => a - b);

  if (uniqueSorted.some((cut) => cut <= 0)) {
    throw new Error('场景切点必须大于 0。');
  }
  if (uniqueSorted.length > 1000) {
    throw new Error('场景切点最多为 1000 个。');
  }
  return uniqueSorted;
}

app.post('/api/fix', upload.single('subtitle'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请先上传 .srt 字幕文件。' });
    }

    const minDurationSeconds = parseNumberField(
      req.body.minDurationSeconds,
      '最短显示时长',
      { min: 0.05, max: 60, fallback: DEFAULTS.minDurationMs / 1000 }
    );
    const maxCps = parseNumberField(
      req.body.maxCps,
      '最大每秒字符数',
      { min: 1, max: 100, fallback: DEFAULTS.maxCps }
    );
    const minGapMs = parseNumberField(
      req.body.minGapMs,
      '最小间隔',
      { min: 0, max: 10000, integer: true, fallback: DEFAULTS.minGapMs }
    );
    const cuts = parseCuts(req.body.cuts);

    const content = req.file.buffer.toString('utf8');
    const originalCues = parseSrt(content);
    const result = fixSubtitles(originalCues, cuts, {
      minDurationMs: Math.round(minDurationSeconds * 1000),
      maxCps,
      minGapMs,
    });

    if (!result.feasible) {
      return res.status(422).json({
        feasible: false,
        cuts,
        options: { minDurationSeconds, maxCps, minGapMs },
        originalCues,
        conflict: result.conflict,
      });
    }

    return res.json({
      feasible: true,
      cuts,
      options: { minDurationSeconds, maxCps, minGapMs },
      originalCues,
      fixedCues: result.cues,
      fixedSrt: serializeSrt(result.cues),
      stats: result.stats,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`SRT 时轴修复工具已启动：http://localhost:${PORT}`);
});

module.exports = app;
