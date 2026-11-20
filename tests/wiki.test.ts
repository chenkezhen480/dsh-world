import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArchiveStore } from '../src/store.ts';
import { createMemory } from '../src/memory.ts';
import type { AuthorDoc } from '../src/memoryFiles.ts';
import { extractPageLinks } from '../src/memoryStore.ts';
import { CATALOG_CAP, pageRelations, wikiCatalog, wikiGaps } from '../src/wiki.ts';
import { wikiRefusal } from '../src/life/diary.ts';
import { memoryTools } from '../src/memoryTools.ts';
import { record } from './fixtures.ts';

/** A page as the file source gives it: only what the wiki functions read. */
const page = (title: string, content: string, timeMs = 0) => ({ title, content, timeMs, pages: extractPageLinks(content), links: [] as string[] }) as unknown as AuthorDoc;

test('a page links by title; links each way are worked out from all pages, the catalog never counts as linking to one', () => {
  assert.deepEqual(extractPageLinks('见 [[小林]] 和 [[ 星铁 ]]，又是 [[小林]]；[[]] 不算'), ['小林', '星铁']);
  const pages = [page('小林', '和 [[星铁]] 有关，还有 [[小林（大学同学）]]'), page('星铁', '玩的时候 [[小林]] 也在'), page('音乐', '[[小林]] 说了很久'), page('目录', '- [[小林]]\n- [[星铁]]')];
  assert.deepEqual(pageRelations(pages[0]!, pages), { links: ['小林（大学同学）', '星铁'], linkedFrom: ['星铁', '音乐'], missing: ['小林（大学同学）'] });
  // File names are compared the way Windows compares them.
  assert.deepEqual(pageRelations(page('Star Rail', ''), [page('Star Rail', ''), page('笔记', '[[star rail]]')]).linkedFrom, ['笔记']);
  const many = Array.from({ length: 25 }, (_unused, index) => page(`页${String(index).padStart(2, '0')}`, '[[中心]]'));
  const center = page('中心', many.map(each => `[[${each.title}]]`).join(' '));
  const related = pageRelations(center, [center, ...many]);
  assert.equal(related.links.length, 20); assert.equal(related.linkedFrom.length, 20);
  assert.deepEqual(related.more, { links: 5, linkedFrom: 5 });
  // A hub naming pages not written yet is cut the same way: the lists go out with every later step.
  const hub = pageRelations(page('总览', Array.from({ length: 150 }, (_unused, index) => `[[待写${index}]]`).join(' ')), []);
  assert.deepEqual([hub.missing.length, hub.more], [20, { links: 130, missing: 130 }]);
});

test('a session starts with her own catalog, cut like her 我是谁; before she writes one, with the page names, newest first', () => {
  const dir = 'C:\\room\\认识';
  assert.equal(wikiCatalog([], dir), undefined, 'no page, nothing at all');
  assert.equal(wikiCatalog([page('目录', '  ')], dir), undefined);
  const own = wikiCatalog([page('小林', '正文里的秘密'), page('目录', '- [[小林]]｜几次相处')], dir)!;
  assert.match(own, /^【我写过的认识】页面在 C:\\room\\认识，/);
  assert.match(own, /<目录\.md>\n- \[\[小林\]\]｜几次相处\n<\/目录\.md>$/);
  assert.doesNotMatch(own, /正文里的秘密/, 'never a page body');
  const long = wikiCatalog([page('目录', '字'.repeat(CATALOG_CAP + 30))], dir)!;
  assert.match(long, /（目录后面还有 30 字没读进来，要看全就读 目录\.md。）$/);
  const names = wikiCatalog([page('旧的', '', 1), page('新的', '', 3), page('中间', '', 2)], dir)!;
  assert.match(names, /还没有整理目录[^\n]*\n- \[\[新的\]\]\n- \[\[中间\]\]\n- \[\[旧的\]\]$/);
  const crowd = wikiCatalog(Array.from({ length: 400 }, (_unused, index) => page(`一个名字比较长的页面${index}`, '', index)), dir)!;
  assert.match(crowd, /（只列出最近改过的 \d+ 页，共 400 页，其余用 memory_find 翻。）$/);
  assert.match(crowd, /- \[\[一个名字比较长的页面399\]\]/, 'the newest page comes first');
});

test('her evening review is told what her wiki is missing, and nothing when it is whole', () => {
  const index = page('目录', '- [[小林]]');
  assert.equal(wikiGaps([page('小林', '[[目录]]'), index]), undefined);
  const gaps = wikiGaps([page('小林', '见 [[小林（大学同学）]]'), page('星铁', ''), index], doc => doc.title === '星铁' ? ['m1.x'] : [])!;
  assert.equal(gaps, '认识页的情况：1 处 [[链接]] 指向还没有的页：小林 → 小林（大学同学）（写那一页，或者改成对的名字）；1 页还不在目录.md 里：星铁；1 页里有「引用：」指向的原文已经改过：星铁。整理认识时顺手处理。');
  assert.match(wikiGaps([page('小林', ''), page('星铁', '')])!, /有 2 页，还没有目录\.md/);
  assert.equal(wikiGaps([page('小林', ''), page('星铁', ''), page('目录', '小林：几次相处\n星铁：一起玩过的活动')]), undefined, 'a catalog line without [[ ]] still lists its page');
  const crowd = wikiGaps(Array.from({ length: 8 }, (_unused, index) => page(`页${index}`, '[[没有]]')))!;
  assert.match(crowd, /8 处 \[\[链接\]\] 指向还没有的页：页0 → 没有、页1 → 没有、页2 → 没有、页3 → 没有、页4 → 没有 等 8 个/);
});

test('only her home writes her wiki; other sessions are told to note it in today\'s diary, and nothing else is judged', () => {
  const wiki = 'C:\\world\\room\\认识', cwd = 'C:\\world\\room';
  const write = (path: string) => ({ file_path: path, content: '…' });
  assert.equal(wikiRefusal('write', write(join(wiki, '小林.md')), wiki, cwd, true), undefined, 'at home');
  assert.match(wikiRefusal('write', write(join(wiki, '小林.md')), wiki, cwd, false)!, /认识页只在家里整理.*先记进今天的日记/);
  assert.match(wikiRefusal('edit', write('认识/小林.md'), wiki, cwd, false)!, /认识页只在家里整理/, 'a relative path resolves against the session\'s folder');
  assert.equal(wikiRefusal('read', write(join(wiki, '小林.md')), wiki, cwd, false), undefined, 'reading is anyone\'s');
  assert.equal(wikiRefusal('write', write(join(cwd, '日记', '2026-11-19.md')), wiki, cwd, false), undefined);
});

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-wiki-'));
  const paths = { diaryDir: join(root, 'room', '日记'), wikiDir: join(root, 'room', '认识') };
  await mkdir(paths.diaryDir, { recursive: true }); await mkdir(paths.wikiDir, { recursive: true });
  const store = createArchiveStore({ root, worldId: 'fish', timeZone: 'Asia/Seoul', agentPreset: 'companion' });
  const memory = createMemory({ store: store.memory, timeZone: 'Asia/Seoul', sources: paths, visible: () => true });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { paths, store, memory };
}

test('her wiki pages are one more kind of long-term memory: found by any word in them, named by their file, timed by their last change', async t => {
  const s = await setup(t);
  await writeFile(join(s.paths.wikiDir, '小林.md'), '别称：林子\n第一次见他时我觉得有点冷淡，后来聊起音乐，他说了很久。');
  await writeFile(join(s.paths.diaryDir, '2026-11-18.md'), '今天和林子聊了音乐');
  await s.store.commitRecords([record('a1', { content: '林子说他喜欢爵士' })]);
  const wiki = await s.memory.find({ kinds: ['wiki'], query: '林子' });
  assert.deepEqual(wiki.items.map(item => [item.kind, item.title, item.timeBasis]), [['wiki', '小林', 'fileObserved']]);
  assert.deepEqual((await s.memory.find({ query: '林子' })).items.map(item => item.kind).sort(), ['conversation', 'diary', 'wiki'], 'without kinds, all three');
  await rm(join(s.paths.wikiDir, '小林.md'));
  assert.equal((await s.memory.find({ kinds: ['wiki'] })).items.length, 0, 'a deleted page is gone');
  assert.equal((await s.memory.find({ kinds: ['diary'] })).items.length, 1, 'the diary is untouched');
});

test('a page comes back with its links each way, worked out afresh, and a stale 引用 is named', async t => {
  const s = await setup(t);
  await writeFile(join(s.paths.wikiDir, '星铁.md'), '玩的时候 [[小林]] 也在');
  await writeFile(join(s.paths.diaryDir, '2026-11-19.md'), '今天点了蓝球');
  const [diary] = (await s.memory.find({ kinds: ['diary'] })).items;
  await writeFile(join(s.paths.wikiDir, '小林.md'), `和 [[音乐]] 有关\n引用：memory:${diary!.ref}`);
  const [found] = (await s.memory.find({ kinds: ['wiki'], query: '音乐' })).items;
  assert.deepEqual(found!.related, { links: ['音乐'], linkedFrom: ['星铁'], missing: ['音乐'] });
  await writeFile(join(s.paths.wikiDir, '音乐.md'), '爵士');
  assert.ok((await s.memory.find({ kinds: ['wiki'], query: '音乐' })).items.some(item => item.title === '音乐'), 'a page is found by its title alone');
  await writeFile(join(s.paths.diaryDir, '2026-11-19.md'), '今天点了蓝球，后来又点了红球');
  const read = await s.memory.read({ ref: (await s.memory.find({ kinds: ['wiki'], query: '音乐' })).items.find(item => item.title === '小林')!.ref });
  assert.deepEqual(read.related, { links: ['音乐'], linkedFrom: ['星铁'], missing: [], staleRefs: [diary!.ref] }, 'the page it named now exists; the diary it cited has changed');
  assert.match((await s.memory.wiki.gaps())!, /1 页里有「引用：」指向的原文已经改过：小林/);
});

test('a page opens by the name she knows it by, with its relations; a name that fits none is refused with the names there are', async t => {
  const s = await setup(t);
  await writeFile(join(s.paths.wikiDir, '星铁.md'), '玩的时候 [[小林]] 也在');
  await writeFile(join(s.paths.wikiDir, '小林.md'), `别称：林子\n${'慢热。'.repeat(10)}\n相关：[[城南的唱片店]]`);
  for (const title of ['小林', '[[小林]]', '小林.md', ' 小林 ']) {
    const page = await s.memory.wiki.open({ title });
    assert.equal(page.title, '小林', title);
    assert.deepEqual(page.related, { links: ['城南的唱片店'], linkedFrom: ['星铁'], missing: ['城南的唱片店'] });
  }
  const first = await s.memory.wiki.open({ title: '小林', limit: 10 });
  assert.deepEqual([first.content, first.nextOffset, first.totalChars], ['别称：林子\n慢热。慢', 10, 50], 'a long page is read in stretches');
  assert.equal((await s.memory.wiki.open({ title: '小林', offset: first.nextOffset })).content.startsWith('热。'), true);
  await assert.rejects(s.memory.wiki.open({ title: '林' }), /没有叫「林」的认识页；有的页：小林/, 'a near name is offered');
  await assert.rejects(s.memory.wiki.open({ title: '唱片店' }), /没有叫「唱片店」的认识页；有的页：(小林、星铁|星铁、小林)/, 'else the newest pages');
  await assert.rejects(s.memory.wiki.open({}), /title 写认识页的页名/);
  const page = (await s.memory.find({ kinds: ['wiki'], query: '林子' })).items[0]!;
  assert.equal((await s.memory.read({ ref: page.ref })).content, (await s.memory.wiki.open({ title: '小林' })).content, 'the same page either way');
});

test('wiki_open is there only with a wiki, and returns the page short: no bookkeeping fields, empty relations left out', async t => {
  const s = await setup(t);
  await writeFile(join(s.paths.wikiDir, '小林.md'), '慢热');
  const open = memoryTools(s.memory, () => true).find(tool => tool.name === 'wiki_open')!;
  const shown = JSON.parse(await open.execute({ title: '小林' } as never, { signal: new AbortController().signal } as never) as string);
  assert.deepEqual(Object.keys(shown), ['title', 'time', 'content', 'offset', 'totalChars']);
  assert.equal(shown.content, '慢热');
  const noWiki = createMemory({ store: s.store.memory, timeZone: 'Asia/Seoul', sources: { diaryDir: s.paths.diaryDir }, visible: () => true });
  assert.ok(!memoryTools(noWiki, () => true).some(tool => tool.name === 'wiki_open'));
});

test('the catalog and the gaps come from the same files, and an unreadable page is reported, not hidden', async t => {
  const s = await setup(t);
  assert.deepEqual(await s.memory.wiki.catalog(), {}, 'an empty wiki has no catalog');
  await writeFile(join(s.paths.wikiDir, '目录.md'), '- [[小林]]｜几次相处');
  await writeFile(join(s.paths.wikiDir, '小林.md'), '正文');
  assert.match((await s.memory.wiki.catalog()).text!, /<目录\.md>\n- \[\[小林\]\]｜几次相处\n<\/目录\.md>/);
  assert.equal(await s.memory.wiki.gaps(), undefined);
  await writeFile(join(s.paths.wikiDir, '坏的.md'), Buffer.from([0xff, 0xfe, 0x00]));
  const { text, failure } = await s.memory.wiki.catalog();
  assert.ok(text, 'what can be read is still there');
  assert.match(failure!, /坏的\.md.*UTF-8/);
});
