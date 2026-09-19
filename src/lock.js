'use strict';

/**
 * 解析用户输入的锁定字幕编号。
 * 支持：
 *   1, 3, 5-8
 *   1 3 5～8（空格、全角逗号、顿号、分号均可分隔）
 *   2-4、2–4、2—4、2~4
 * 返回去重并升序排列的编号数组（编号从 1 开始，对应 SRT 块序号）。
 */
function parseLockedIndices(text, total) {
  const pieces = String(text ?? '')
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const indices = [];
  for (const piece of pieces) {
    const match = piece.match(/^(\d{1,6})(?:\s*[-–—~～]\s*(\d{1,6}))?$/);
    if (!match) {
      throw new Error(`锁定字幕编号无法识别：“${piece}”，请输入编号或起止范围，例如 1,3,5-8。`);
    }

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (match[2] !== undefined && end < start) {
      throw new Error(`锁定范围 ${piece} 无效：起始编号不能大于结束编号。`);
    }
    if (start < 1 || end < 1) {
      throw new Error('锁定字幕编号必须从 1 开始。');
    }
    if (Number.isFinite(total) && (start > total || end > total)) {
      throw new Error(`锁定字幕编号 ${end} 超出范围：本文件共 ${total} 条字幕。`);
    }

    for (let value = start; value <= end; value += 1) {
      indices.push(value);
    }
  }

  return [...new Set(indices)].sort((a, b) => a - b);
}

module.exports = { parseLockedIndices };
