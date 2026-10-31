import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecallIndex } from '../src/life/recall.ts';

const fixedNow = () => Date.parse('2026-10-31T12:00:00+08:00');

async function setup(t: test.TestContext) {
  const worldDir = await mkdtemp(join(tmpdir(), 'dsh-world-recall-'));
  const diaryDir = join(worldDir, 'diary');
  const conversationsDir = join(worldDir, 'conversations');
  const activityDir = join(worldDir, 'activity');
  for (const dir of [diaryDir, conversationsDir, activityDir]) await mkdir(dir, { recursive: true });
  const index = createRecallIndex({ worldDir, diaryDir, timeZone: 'Asia/Shanghai', selfName: '鲸鲸', partnerName: '主人', now: fixedNow });
  t.after(async () => { index.close(); await rm(worldDir, { recursive: true, force: true }); });
  return { worldDir, diaryDir, conversationsDir, activityDir, index };
}

const chat = (recordId: string, occurredAt: string, role: 'user' | 'assistant', content: string) => JSON.stringify({ recordId, occurredAt, role, content });

test('finds a spoken line and keeps the line number it came from', async t => {
  const s = await setup(t);
  await writeFile(join(s.conversationsDir, '2026-10-24.jsonl'), [
    chat('r1', '2026-10-24T13:37:00.000Z', 'user', '本鱼的眼镜片有点花了，想换一副'),
    chat('r2', '2026-10-24T13:38:00.000Z', 'assistant', '换吧，别拖到看不清黑板'),
  ].join('\n'));
  const out = s.index.search({ query: '眼镜' });
  assert.match(out, /找到 1 条/);
  assert.match(out, /主人：本鱼的眼镜片有点花了/);
  assert.match(out, /conversations\/2026-10-24\.jsonl:1/);
});

test('a diary entry rewritten at night is searched as it reads now, not as it read before', async t => {
  const s = await setup(t);
  const file = join(s.diaryDir, '2026-10-26.md');
  await writeFile(file, '# 2026-10-26\n\n## 23:04 配眼镜\n\n今天去配了副新眼镜，蓝框的。\n');
  assert.match(s.index.search({ query: '眼镜' }), /蓝框的/);
  await writeFile(file, '# 2026-10-26\n\n## 23:04 配眼镜\n\n最后没配成，验光排队太久了。\n');
  const out = s.index.search({ query: '验光' });
  assert.match(out, /验光排队太久/);
  assert.match(out, /diary\/2026-10-26\.md:3/);
  assert.doesNotMatch(s.index.search({ query: '蓝框' }), /蓝框的/);
});

test('a source that is deleted takes its rows with it', async t => {
  const s = await setup(t);
  const file = join(s.activityDir, '2026-10-25.jsonl');
  await writeFile(file, `${JSON.stringify({ time: '2026-10-25T09:00:00.000Z', tool: 'read', summary: '看了一遍房间里的东西' })}\n`);
  assert.match(s.index.search({ query: '房间' }), /看了一遍房间/);
  await unlink(file);
  assert.match(s.index.search({ query: '房间' }), /没有找到/);
});

test('what she wrote down outlasts what she merely lived through', async t => {
  const s = await setup(t);
  await writeFile(join(s.conversationsDir, '2026-08-01.jsonl'), [chat('old', '2026-08-01T10:00:00.000Z', 'user', '那天在江边说到灯塔的事')].join('\n'));
  await writeFile(join(s.diaryDir, '2026-08-01.md'), '# 2026-08-01\n\n## 夜里 灯塔\n\n那天在江边说到灯塔，本鱼记下来了。\n');
  const out = s.index.search({ query: '灯塔' });
  const diaryAt = out.indexOf('〔日记〕');
  const chatAt = out.indexOf('〔聊天〕');
  assert.ok(diaryAt >= 0 && chatAt > diaryAt, `diary should rank before chat:\n${out}`);
});

test('date range and source filters narrow without hiding the total', async t => {
  const s = await setup(t);
  await writeFile(join(s.conversationsDir, '2026-10-20.jsonl'), [chat('a', '2026-10-20T10:00:00.000Z', 'user', '说过生日要买蛋糕')].join('\n'));
  await writeFile(join(s.diaryDir, '2026-10-27.md'), '# 2026-10-27\n\n## 21:00 生日\n\n蛋糕上的蜡烛吹了三次。\n');
  assert.match(s.index.search({ query: '蛋糕', sources: ['chat'] }), /说过生日要买蛋糕/);
  assert.doesNotMatch(s.index.search({ query: '蛋糕', sources: ['chat'] }), /蜡烛/);
  const ranged = s.index.search({ query: '蛋糕', from: '2026-10-25', to: '2026-10-31' });
  assert.match(ranged, /蜡烛/);
  assert.doesNotMatch(ranged, /买蛋糕/);
});

test('an empty query and a date that is not a date are refused in plain words', async t => {
  const s = await setup(t);
  assert.throws(() => s.index.search({ query: '   ' }), /给本鱼一个词/);
  assert.throws(() => s.index.search({ query: '眼镜', from: '前天' }), /YYYY-MM-DD/);
});

test('nothing found says so instead of inventing a memory', async t => {
  const s = await setup(t);
  const out = s.index.search({ query: '银河系漫游指南' });
  assert.match(out, /没有找到/);
  assert.match(out, /别编/);
});