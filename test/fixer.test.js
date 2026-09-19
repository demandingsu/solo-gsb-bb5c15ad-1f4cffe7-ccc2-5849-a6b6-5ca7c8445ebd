'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fixSubtitles, DEFAULTS } = require('../src/fixer');
const { parseSrt, serializeSrt, visibleLength } = require('../src/srt');
const { parseFlexibleTime } = require('../src/time');

function cue(index, start, end, text) {
  return {
    index,
    sequence: index,
    start,
    end,
    duration: end - start,
    text,
    chars: visibleLength(text),
  };
}

test('延长字幕以满足最短显示时长和 CPS', () => {
  const result = fixSubtitles(
    [cue(1, 0, 300, '你好')],
    [],
    { minDurationMs: 500, maxCps: 4, minGapMs: 80 }
  );

  assert.equal(result.feasible, true);
  assert.equal(result.cues[0].start, 0);
  assert.ok(result.cues[0].duration >= 500);
});

test('联动后移后续字幕并保持最小间隔', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 100, 'aaaaaaaaaa'),
      cue(2, 150, 300, 'bbbbbbbbbb'),
    ],
    [2500],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100 }
  );

  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.cues.map((item) => [item.start, item.end]),
    [[0, 1000], [1100, 2100]]
  );
});

test('切点两侧字幕不会覆盖切点', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 100, 'a'),
      cue(2, 1100, 1200, 'b'),
    ],
    [1000],
    { minDurationMs: 500, maxCps: 100, minGapMs: 100 }
  );

  assert.equal(result.feasible, true);
  assert.ok(result.cues[0].end <= 1000);
  assert.ok(result.cues[1].start >= 1000);
  assert.ok(result.cues[1].start - result.cues[0].end >= 100);
});

test('同一区间容量不足时标出最短连续字幕段', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 100, 'aaaaaaaaaa'),
      cue(2, 150, 300, 'bbbbbbbbbb'),
    ],
    [2000],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100 }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 2);
  assert.equal(result.conflict.requiredMs, 2100);
  assert.equal(result.conflict.availableMs, 2000);
  assert.match(result.conflict.reason, /最短连续字幕段/);
});

test('单条字幕比切点区间更长时只标出该字幕', () => {
  const result = fixSubtitles(
    [cue(1, 200, 300, 'xxxxxxxxxx')],
    [500],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100 }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 1);
});

test('相邻字幕的切点归属顺序颠倒时标出这两条', () => {
  const result = fixSubtitles(
    [
      cue(1, 1200, 1300, 'a'),
      cue(2, 500, 600, 'b'),
    ],
    [1000],
    { minDurationMs: 100, maxCps: 100, minGapMs: 20 }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.type, 'scene-order');
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 2);
});

test('解析和序列化 SRT', () => {
  const cues = parseSrt(
    '1\r\n00:00:01,200 --> 00:00:02,300\r\n<b>Hello</b> world\r\n\r\n' +
    '2\n00:00:03.000 --> 00:00:04,000\n你好\n'
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1200);
  assert.equal(cues[0].chars, 10);
  assert.match(serializeSrt(cues), /00:00:01,200 --> 00:00:02,300/);
});

test('解析多种切点时间格式', () => {
  assert.equal(parseFlexibleTime('12.5'), 12500);
  assert.equal(parseFlexibleTime('01:30.500'), 90500);
  assert.equal(parseFlexibleTime('00:01:30,500'), 90500);
});

test('使用默认参数', () => {
  assert.deepEqual(DEFAULTS, {
    minDurationMs: 500,
    maxCps: 15,
    minGapMs: 80,
  });
});

test('锁定字幕保留原始起止时间，相邻未锁定字幕照常联动', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 100, 'aaaaaaaaaa'),
      cue(2, 150, 300, 'bbbbbbbbbb'),
      cue(3, 3000, 3100, 'cccccccccc'),
    ],
    [5000],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100, lockedIndices: [3] }
  );

  assert.equal(result.feasible, true);
  // 锁定项原封不动
  const locked = result.cues[2];
  assert.equal(locked.start, 3000);
  assert.equal(locked.end, 3100);
  assert.equal(locked.startShift, 0);
  assert.equal(locked.endShift, 0);
  assert.equal(locked.locked, true);
  // 未锁定项延长并保持间隔
  assert.deepEqual(
    result.cues.slice(0, 2).map((item) => [item.start, item.end]),
    [[0, 1000], [1100, 2100]]
  );
  assert.equal(result.stats.locked, 1);
  assert.equal(result.stats.moved, 2);
});

test('锁定项作为双边锚点向前约束：前置字幕被迫前移以避开锚点', () => {
  const result = fixSubtitles(
    [
      cue(1, 600, 700, 'aaaaaaaaaa'),
      cue(2, 1500, 1600, 'bbbbbbbbbb'),
    ],
    [],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100, lockedIndices: [2] }
  );

  assert.equal(result.feasible, true);
  assert.deepEqual(
    [result.cues[1].start, result.cues[1].end],
    [1500, 1600]
  );
  // 第 1 条原始开始 600 + 需要 1000 ms 会压到锚点，锚点把它提前到 [400, 1400]
  assert.deepEqual(
    [result.cues[0].start, result.cues[0].end],
    [400, 1400]
  );
});

test('两个锁定锚点间距不足时返回包含锚点的最短冲突段', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 1200, 'aaaaaaaaaaaa'),
      cue(2, 1250, 2450, 'bbbbbbbbbbbb'),
    ],
    [],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100, lockedIndices: [1, 2] }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.type, 'capacity');
  assert.equal(result.conflict.fromIndex, 1);
  assert.equal(result.conflict.toIndex, 2);
  assert.deepEqual(result.conflict.lockedIndices, [1, 2]);
  // 锁定时长 1200 + 间隔 100 + 锁定时长 1200 = 2500；锚点跨度 0→2450 只有 2450
  assert.equal(result.conflict.requiredMs, 2500);
  assert.equal(result.conflict.availableMs, 2450);
  assert.equal(result.conflict.overflowMs, 50);
  assert.match(result.conflict.reason, /锁定字幕/);
});

test('锁定锚点与切点容量冲突时冲突段必须包含锚点', () => {
  const result = fixSubtitles(
    [
      cue(1, 0, 100, 'aaaaaaaaaa'),
      cue(2, 1050, 1150, 'bbbbbbbbbb'),
    ],
    [2000],
    { minDurationMs: 500, maxCps: 10, minGapMs: 100, lockedIndices: [2] }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.toIndex, 2);
  assert.ok(result.conflict.lockedIndices.includes(2));
});

test('锁定字幕原始时间覆盖切点时报告 locked-cut 冲突', () => {
  const result = fixSubtitles(
    [cue(1, 800, 1300, 'hello')],
    [1000],
    { minDurationMs: 100, maxCps: 100, minGapMs: 20, lockedIndices: [1] }
  );

  assert.equal(result.feasible, false);
  assert.equal(result.conflict.type, 'locked-cut');
  assert.deepEqual(result.conflict.lockedIndices, [1]);
  assert.equal(result.conflict.requiredMs, 500);
  assert.equal(result.conflict.leftMs, 200);
  assert.equal(result.conflict.rightMs, 300);
  assert.match(result.conflict.reason, /覆盖了场景切点/);
});

test('锁定字幕恰好结束于/开始于切点不算冲突', () => {
  const result = fixSubtitles(
    [
      cue(1, 500, 1000, 'hello'),
      cue(2, 1000, 1500, 'world'),
    ],
    [1000],
    { minDurationMs: 100, maxCps: 100, minGapMs: 0, lockedIndices: [1, 2] }
  );

  assert.equal(result.feasible, true);
  assert.deepEqual(
    result.cues.map((item) => [item.start, item.end]),
    [[500, 1000], [1000, 1500]]
  );
});

test('锁定字幕即使原始时长短于最短时长也不被延长', () => {
  const result = fixSubtitles(
    [cue(1, 5000, 5200, 'x')],
    [],
    { minDurationMs: 500, maxCps: 100, minGapMs: 80, lockedIndices: [1] }
  );

  assert.equal(result.feasible, true);
  assert.deepEqual(
    [result.cues[0].start, result.cues[0].end],
    [5000, 5200]
  );
});

test('锁定字幕编号解析', () => {
  const { parseLockedIndices } = require('../src/lock');
  assert.deepEqual(parseLockedIndices('1, 3, 5-7、9 12'), [1, 3, 5, 6, 7, 9, 12]);
  assert.deepEqual(parseLockedIndices('2–4;6；8~9', 12), [2, 3, 4, 6, 8, 9]);
  assert.deepEqual(parseLockedIndices(''), []);
  assert.deepEqual(parseLockedIndices(undefined, 3), []);
  assert.throws(() => parseLockedIndices('1,abc', 5), /无法识别/);
  assert.throws(() => parseLockedIndices('5-3', 5), /起始编号不能大于结束编号/);
  assert.throws(() => parseLockedIndices('6', 5), /超出范围/);
  assert.throws(() => parseLockedIndices('0', 5), /从 1 开始/);
});
