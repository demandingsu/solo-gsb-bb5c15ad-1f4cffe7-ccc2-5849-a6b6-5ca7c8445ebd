'use strict';

const { formatTime } = require('./time');

const DEFAULTS = {
  minDurationMs: 500,
  maxCps: 15,
  minGapMs: 80,
};

function ceilDiv(a, b) {
  return Math.ceil(a / b);
}

function upperBound(sortedNumbers, value) {
  let low = 0;
  let high = sortedNumbers.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedNumbers[middle] <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * 有界单调回归：
 * 最小化 sum((y_i - target_i)^2)，同时满足：
 *   y_0 <= y_1 <= ...
 *   lower_i <= y_i <= upper_i
 *
 * 等权 PAVA（Pool Adjacent Violators Algorithm）。
 * 先在实数域求带上下界的非递减最小二乘解：合并后的块取
 * 目标均值，并裁剪到该块所有盒约束的交集；若相邻块值不再
 * 非递减则继续合并。最后整体向下取整，得到毫秒整数，且
 * 不破坏整数上下界与非递减约束。
 */
function boundedIsotonicRegression(targets, lower, upper) {
  const blocks = [];

  for (let i = 0; i < targets.length; i += 1) {
    let block = {
      start: i,
      end: i,
      sum: targets[i],
      count: 1,
      maxLower: lower[i],
      minUpper: upper[i],
      value: 0,
    };

    if (block.maxLower > block.minUpper) {
      return { error: { start: i, end: i } };
    }
    block.value = clipReal(block.sum / block.count, block.maxLower, block.minUpper);

    while (blocks.length > 0 && blocks[blocks.length - 1].value > block.value) {
      const previous = blocks.pop();
      block = {
        start: previous.start,
        end: block.end,
        sum: previous.sum + block.sum,
        count: previous.count + block.count,
        maxLower: Math.max(previous.maxLower, block.maxLower),
        minUpper: Math.min(previous.minUpper, block.minUpper),
        value: 0,
      };
      if (block.maxLower > block.minUpper) {
        return { error: { start: block.start, end: block.end } };
      }
      block.value = clipReal(
        block.sum / block.count,
        block.maxLower,
        block.minUpper
      );
    }

    blocks.push(block);
  }

  const result = new Array(targets.length);
  for (const block of blocks) {
    const value = Math.floor(block.value);
    for (let i = block.start; i <= block.end; i += 1) {
      result[i] = value;
    }
  }
  return { values: result };
}

function clipReal(value, lower, upper) {
  if (value < lower) return lower;
  if (Number.isFinite(upper) && value > upper) return upper;
  return value;
}

function summarizeCue(cue, requiredDuration) {
  return {
    index: cue.index,
    start: cue.start,
    end: cue.end,
    text: cue.text,
    chars: cue.chars,
    requiredDuration,
  };
}

function findShortestCapacityConflict(transformedLower, transformedUpper) {
  let best = null;

  // 单调栈保存从当前位置回看的“候选最大值”，索引递增、数值严格递减。
  const stack = [];
  for (let q = 0; q < transformedLower.length; q += 1) {
    const lowerValue = transformedLower[q];
    while (stack.length > 0 && stack[stack.length - 1].value <= lowerValue) {
      stack.pop();
    }
    stack.push({ index: q, value: lowerValue });

    const upperValue = transformedUpper[q];
    if (upperValue === Infinity) continue;

    // 数值递减：大于阈值的是前缀；找前缀中最后一个，即第一个不满足项的前一位。
    let low = 0;
    let high = stack.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (stack[middle].value > upperValue) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) {
      const p = stack[low - 1].index;
      if (!best || q - p < best.to - best.from) {
        best = { from: p, to: q };
      }
    }
  }

  return best;
}

function fixSubtitles(inputCues, cuts, inputOptions = {}) {
  const options = { ...DEFAULTS, ...inputOptions };
  const cues = inputCues.map((cue, arrayIndex) => {
    const requiredDuration = Math.max(
      cue.duration,
      options.minDurationMs,
      ceilDiv(cue.chars * 1000, options.maxCps)
    );
    return {
      ...cue,
      arrayIndex,
      originalDuration: cue.duration,
      requiredDuration,
    };
  });

  const groups = cues.map((cue) =>
    upperBound(cuts, Math.floor((cue.start + cue.end) / 2))
  );

  const count = cues.length;
  const lower = new Array(count);
  const upper = new Array(count);

  for (let i = 0; i < count; i += 1) {
    const group = groups[i];
    lower[i] = group === 0 ? 0 : cuts[group - 1];
    upper[i] = group < cuts.length ? cuts[group] - cues[i].requiredDuration : Infinity;
  }

  // o_i 为从第 0 条依次排到第 i 条开始位置的累计偏移。
  const offsets = new Array(count).fill(0);
  for (let i = 1; i < count; i += 1) {
    offsets[i] =
      offsets[i - 1] + cues[i - 1].requiredDuration + options.minGapMs;
  }

  const targets = cues.map((cue, i) => cue.start - offsets[i]);
  const transformedLower = lower.map((value, i) => value - offsets[i]);
  const transformedUpper = upper.map((value, i) =>
    value === Infinity ? Infinity : value - offsets[i]
  );

  const capacityConflict = findShortestCapacityConflict(
    transformedLower,
    transformedUpper
  );

  // 相邻字幕若被切点分到相反侧，顺序约束与切点约束直接冲突。
  let orderConflict = null;
  for (let i = 0; i + 1 < count; i += 1) {
    if (groups[i] > groups[i + 1]) {
      orderConflict = { from: i, to: i + 1 };
      break;
    }
  }

  let conflictLocation = null;
  if (capacityConflict && (!orderConflict ||
    capacityConflict.to - capacityConflict.from <=
      orderConflict.to - orderConflict.from)) {
    conflictLocation = capacityConflict;
  } else if (orderConflict) {
    conflictLocation = orderConflict;
  }

  if (conflictLocation) {
    const p = conflictLocation.from;
    const q = conflictLocation.to;
    const firstGroup = groups[p];
    const lastGroup = groups[q];

    let type = 'capacity';
    let reason;

    if (q === p + 1 && firstGroup > lastGroup) {
      type = 'scene-order';
      reason =
        `第 ${cues[p].index} 条字幕的原始中点位于某个切点之后，` +
        `第 ${cues[q].index} 条字幕却必须位于更早的切点之前；` +
        '保持字幕顺序与禁止跨越切点无法同时满足。请人工拆分、删减或改排这两条字幕。';
    } else {
      const lowerMs = lower[p];
      const upperCut = cuts[lastGroup];
      const requiredMs =
        offsets[q] - offsets[p] + cues[q].requiredDuration;
      const availableMs = upperCut - lowerMs;
      const overflowMs = requiredMs - availableMs;
      const lowerLabel = firstGroup === 0
        ? '时间轴起点 00:00:00,000'
        : `第 ${firstGroup} 个切点 ${formatTime(lowerMs)}`;
      const upperLabel = `${lastGroup + 1} 个切点 ${formatTime(upperCut)}`;

      if (p === q) {
        reason =
          `第 ${cues[p].index} 条字幕按最短显示时长/每秒字符数至少需要 ${requiredMs} ms，` +
          `但其按原始中点所在区间（${lowerLabel} 至第 ${upperLabel}）只有 ${availableMs} ms，` +
          `超出 ${overflowMs} ms。`;
      } else {
        reason =
          `第 ${cues[p].index}–${cues[q].index} 条是造成无解的最短连续字幕段：` +
          `在满足各条最短时长和相邻最小间隔 ${options.minGapMs} ms 后，` +
          `该段的时间联动需求至少为 ${requiredMs} ms，` +
          `但从 ${lowerLabel} 到第 ${upperLabel} 的外层可用跨度只有 ${availableMs} ms，` +
          `超出 ${overflowMs} ms。`;
      }

      if (firstGroup !== lastGroup) {
        reason += ' 这组字幕跨越了一个或多个切点，各字幕还必须分别留在切点两侧。';
      }
    }

    return {
      feasible: false,
      conflict: {
        type,
        fromIndex: cues[p].index,
        toIndex: cues[q].index,
        reason,
        cues: cues
          .slice(p, q + 1)
          .map((cue) => summarizeCue(cue, cue.requiredDuration)),
        ...(type === 'capacity'
          ? {
              requiredMs:
                offsets[q] - offsets[p] + cues[q].requiredDuration,
              availableMs: cuts[lastGroup] - lower[p],
              overflowMs:
                offsets[q] - offsets[p] + cues[q].requiredDuration -
                (cuts[lastGroup] - lower[p]),
              lowerMs: lower[p],
              upperMs: cuts[lastGroup],
            }
          : {}),
      },
    };
  }

  const regression = boundedIsotonicRegression(
    targets,
    transformedLower,
    transformedUpper
  );

  if (regression.error) {
    // 正常情况下前置的最短窗口检查已经给出更友好的诊断。
    const { start, end } = regression.error;
    return {
      feasible: false,
      conflict: {
        type: 'capacity',
        fromIndex: cues[start].index,
        toIndex: cues[end].index,
        reason: `第 ${cues[start].index}–${cues[end].index} 条字幕的硬约束交集为空。`,
        cues: cues
          .slice(start, end + 1)
          .map((cue) => summarizeCue(cue, cue.requiredDuration)),
      },
    };
  }

  const fixed = cues.map((cue, i) => {
    const start = regression.values[i] + offsets[i];
    const end = start + cue.requiredDuration;
    return {
      ...cue,
      start,
      end,
      duration: end - start,
      startShift: start - cue.start,
      endShift: end - cue.end,
      sceneGroup: groups[i],
      requiredDuration: cue.requiredDuration,
    };
  });

  validateResult(fixed, cuts, options);

  return {
    feasible: true,
    cues: fixed,
    stats: buildStats(fixed, options),
  };
}

function validateResult(cues, cuts, options) {
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (!Number.isInteger(cue.start) || !Number.isInteger(cue.end) || cue.end <= cue.start) {
      throw new Error(`内部错误：第 ${cue.index} 条调整结果无效。`);
    }
    if (cue.start < 0) {
      throw new Error(`内部错误：第 ${cue.index} 条早于时间轴起点。`);
    }
    for (const cut of cuts) {
      if (cue.start < cut && cue.end > cut) {
        throw new Error(`内部错误：第 ${cue.index} 条跨越切点 ${formatTime(cut)}。`);
      }
    }
    if (i > 0) {
      const gap = cue.start - cues[i - 1].end;
      if (gap < options.minGapMs) {
        throw new Error(`内部错误：第 ${cues[i - 1].index} 与第 ${cue.index} 条间隔不足。`);
      }
    }
  }
}

function buildStats(cues, options) {
  let moved = 0;
  let extended = 0;
  let totalAbsShift = 0;

  for (const cue of cues) {
    if (cue.startShift !== 0 || cue.endShift !== 0) moved += 1;
    if (cue.requiredDuration > cue.originalDuration) extended += 1;
    totalAbsShift += Math.abs(cue.startShift) + Math.abs(cue.endShift);
  }

  return {
    total: cues.length,
    moved,
    extended,
    totalAbsShift,
    minGapMs: options.minGapMs,
  };
}

module.exports = {
  DEFAULTS,
  fixSubtitles,
};
