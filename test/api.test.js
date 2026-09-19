'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const app = require('../server');

function srtBlock(index, start, end, text) {
  return `${index}\n${start} --> ${end}\n${text}`;
}

async function withServer(run) {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function buildForm(fields) {
  const boundary = '----srtTestBoundary0123456789';
  const chunks = [];

  for (const [name, value] of Object.entries(fields)) {
    if (name === 'subtitle') {
      chunks.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="subtitle"; filename="sample.srt"\r\n` +
          'Content-Type: text/plain\r\n\r\n'
      );
      chunks.push(Buffer.from(`${value}\r\n`, 'utf8'));
    } else {
      chunks.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`
      );
    }
  }
  chunks.push(`--${boundary}--\r\n`);

  return {
    body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const sampleSrt = [
  srtBlock(1, '00:00:00,000', '00:00:00,100', 'aaaaaaaaaa'),
  srtBlock(2, '00:00:00,150', '00:00:00,300', 'bbbbbbbbbb'),
  srtBlock(3, '00:00:03,000', '00:00:03,100', 'cccccccccc'),
].join('\n\n');

const options = {
  minDurationSeconds: '0.5',
  maxCps: '10',
  minGapMs: '100',
  cuts: '5',
};

test('/api/fix 接受锁定编号并在结果中保留锁定时间', async () => {
  await withServer(async (baseUrl) => {
    const form = buildForm({ ...options, subtitle: sampleSrt, lockedIndices: '3' });
    const response = await fetch(`${baseUrl}/api/fix`, {
      method: 'POST',
      headers: { 'Content-Type': form.contentType },
      body: form.body,
    });

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.feasible, true);
    assert.deepEqual(data.options.lockedIndices, [3]);
    const locked = data.fixedCues[2];
    assert.equal(locked.start, 3000);
    assert.equal(locked.end, 3100);
    assert.equal(locked.locked, true);
    assert.equal(data.stats.locked, 1);
    // 下载内容与预览一致：序列化 SRT 中锁定行时间未变
    assert.match(data.fixedSrt, /00:00:03,000 --> 00:00:03,100/);
  });
});

test('/api/fix 支持范围与多种分隔符的锁定输入', async () => {
  const feasibleSrt = [
    srtBlock(1, '00:00:00,000', '00:00:01,000', 'aaaaaaaaaa'),
    srtBlock(2, '00:00:01,100', '00:00:02,000', 'bbbbbbbbbb'),
    srtBlock(3, '00:00:03,000', '00:00:03,100', 'cccccccccc'),
  ].join('\n\n');

  await withServer(async (baseUrl) => {
    const form = buildForm({ ...options, subtitle: feasibleSrt, lockedIndices: '2-3、1' });
    const response = await fetch(`${baseUrl}/api/fix`, {
      method: 'POST',
      headers: { 'Content-Type': form.contentType },
      body: form.body,
    });

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.options.lockedIndices, [1, 2, 3]);
    assert.equal(data.stats.locked, 3);
  });
});

test('/api/fix 锁定编号超范围时返回 400', async () => {
  await withServer(async (baseUrl) => {
    const form = buildForm({ ...options, subtitle: sampleSrt, lockedIndices: '9' });
    const response = await fetch(`${baseUrl}/api/fix`, {
      method: 'POST',
      headers: { 'Content-Type': form.contentType },
      body: form.body,
    });

    assert.equal(response.status, 400);
    const data = await response.json();
    assert.match(data.error, /超出范围/);
  });
});

test('/api/fix 锁定格式错误时返回 400', async () => {
  await withServer(async (baseUrl) => {
    const form = buildForm({ ...options, subtitle: sampleSrt, lockedIndices: '1,abc' });
    const response = await fetch(`${baseUrl}/api/fix`, {
      method: 'POST',
      headers: { 'Content-Type': form.contentType },
      body: form.body,
    });

    assert.equal(response.status, 400);
    const data = await response.json();
    assert.match(data.error, /无法识别/);
  });
});

test('/api/fix 锁定导致无解时返回 422 并附带锁定锚点信息', async () => {
  const lockedSrt = [
    srtBlock(1, '00:00:00,000', '00:00:01,200', 'aaaaaaaaaaaa'),
    srtBlock(2, '00:00:01,250', '00:00:02,450', 'bbbbbbbbbbbb'),
  ].join('\n\n');

  await withServer(async (baseUrl) => {
    const form = buildForm({
      minDurationSeconds: '0.5',
      maxCps: '10',
      minGapMs: '100',
      cuts: '',
      subtitle: lockedSrt,
      lockedIndices: '1,2',
    });
    const response = await fetch(`${baseUrl}/api/fix`, {
      method: 'POST',
      headers: { 'Content-Type': form.contentType },
      body: form.body,
    });

    assert.equal(response.status, 422);
    const data = await response.json();
    assert.equal(data.feasible, false);
    assert.deepEqual(data.conflict.lockedIndices, [1, 2]);
    assert.equal(data.conflict.requiredMs, 2500);
    assert.equal(data.conflict.availableMs, 2450);
    assert.match(data.conflict.reason, /锁定字幕/);
  });
});
