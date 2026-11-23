import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChange, atTime, experience, newState } from '../../src/experience/experience.mjs';
import { selectConcerns, updateConcerns } from '../../src/experience/concerns.mjs';

const concern = (text, ...cues) => ({ text, cues, revisitAt: null });

test('ordinary turns and tool steps leave the clock alone; only the short-lived state expires', async () => {
  const initial = applyChange({ ...newState(), concerns: [concern('我还想知道后来怎么样了', '近况')] }, { energy: '还挺有劲' }, 0);
  for (let step = 0; step < 100; step++) {
    const result = await experience(() => assert.fail('工具中间步骤不应请求模型'), initial, [], { kind: 'tool-step' });
    assert.equal(result.state, initial);
  }
  const same = applyChange(atTime(initial, 119), { energy: initial.energy }, 119);
  assert.equal(same.energyAt, 0);
  assert.deepEqual(atTime(same, 120), { concerns: initial.concerns, energy: '', energyAt: null });
});

test('closing one matter leaves unrelated matters untouched', async () => {
  const cat = concern('还在等猫回家', '猫');
  const initial = { ...newState(), concerns: [concern('她会来赴约吗', '赴约'), cat] };
  const judgment = { edits: [], resolved: [1], energy: '=' };
  const fake = async () => ({ message: { tool_calls: [{ function: { name: 'record_experience', arguments: JSON.stringify(judgment) } }] }, usage: {} });
  const result = await experience(fake, initial, [], { kind: 'private', text: '她真的来赴约了', minute: 1 });
  assert.deepEqual(result.state.concerns, [cat]);
  assert.equal(result.reply, undefined);
});

test('a self-contained question cannot refresh a paraphrased concern or replay an old reply', async () => {
  const initial = { ...newState(), concerns: [concern('她说周末会来。', '周末')] };
  const judgment = { kind: 'standalone', recalls: [], resolved: [], edits: [], energy: '=', present: '' };
  const requests = [];
  const fake = async messages => {
    requests.push(messages);
    if (requests.length === 1) return { usage: {}, message: { tool_calls: [{ function: { arguments: '{"route":"look_back","answer":"","cues":[]}' } }] } };
    return { usage: {}, message: requests.length === 2
      ? { tool_calls: [{ function: { name: 'record_experience', arguments: JSON.stringify(judgment) } }] }
      : { content: '十二个。' } };
  };
  const row = await experience(fake, initial, [{ role: 'assistant', content: '我都等两次了。' }], { minute: 5, text: '一打是多少？' });
  assert.deepEqual(row.state, initial);
  assert.ok(requests[0].every(m => !m.content.includes('我都等两次了') && !m.content.includes('周末')));
  assert.ok(requests[1].some(m => m.content.includes('我都等两次了')));
  assert.ok(requests[2].every(m => !m.content.includes('我都等两次了') && !m.content.includes('周末')));
});

test('the real host owns its persona and final speech even on a direct answer', async () => {
  let calls = 0;
  const host = { name: '小河', persona: '我是小河，住在这个房间。' };
  const result = await experience(async messages => {
    calls++;
    assert.ok(messages[0].content.includes(host.persona));
    assert.ok(!messages[0].content.includes('阿澄'));
    return { usage: {}, message: { tool_calls: [{ function: { arguments: JSON.stringify({ route: 'answer', answer: '辅助模型的草稿' }) } }] } };
  }, newState(), [], { text: '一打是多少？', minute: 0, host });
  assert.equal(calls, 1);
  assert.equal(result.kind, 'direct');
  assert.equal(result.reply, undefined);
});

test('retrieval is topic first, then bounded by serialized bytes, with zero-budget and legacy support', () => {
  const migrated = atTime({ concern: '明天的面试', energy: '', energyAt: null }, 0);
  const original = [...migrated.concerns, concern('需要找猫'.repeat(80), '猫'), concern('我在等面试结果', '面试')];
  const event = { text: '第一题', minute: 0 };
  assert.deepEqual(selectConcerns(original, ['面试'], event).map(x => x.ref), [1, 3]);
  assert.deepEqual(selectConcerns(original, [], event), []);
  assert.deepEqual(selectConcerns(original, ['面试'], event, 0), []);
  const limited = selectConcerns(original, ['猫'], event, 72);
  assert.equal(limited.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(limited)) <= 72);
  assert.ok(limited[0].text.endsWith('…'));
  assert.equal(original[1].text, '需要找猫'.repeat(80));
  assert.throws(() => updateConcerns(original, limited, [{ ref: 1, text: '', cues: [] }], event));
});

test('an evidenced future opportunity is offered once on an idle turn and survives unrelated chat', () => {
  const event = { text: '明早有面试', minute: 15 };
  const edit = { ref: 0, text: '等面试消息', quote: '明早有面试', cues: ['面试'], timeQuote: '明早', afterMinutes: 600 };
  assert.throws(() => updateConcerns([], [], [{ ...edit, timeQuote: '后天' }], event));
  const items = updateConcerns([], [], [edit], event);
  const wake = { text: '自己空下来了', kind: 'wake', minute: 615 };
  assert.deepEqual(selectConcerns(items, [], { ...wake, kind: 'chat' }), []);
  assert.deepEqual(selectConcerns(items, [], { ...wake, minute: 614 }), []);
  const due = selectConcerns(items, [], wake);
  assert.deepEqual(due, [{ ref: 1, text: '等面试消息\n当时伙伴的原话：明早有面试', due: true }]);
  const next = updateConcerns(items, due, [], wake);
  assert.deepEqual(selectConcerns(next, [], wake), []);
  assert.equal(selectConcerns(next, ['面试'], { ...wake, kind: 'chat' }).length, 1);
});

test('one turn can close an item, amend another and add a third, without addressing any hidden record', () => {
  const hidden = concern('等雨停再去散步', '散步');
  const items = [concern('等猫回家', '找猫'), hidden, concern('等面试结果', '面试')];
  const event = { minute: 0, text: '猫回来了，面试还有复试，搬家也定了。' };
  const visible = selectConcerns(items, ['找猫', '面试'], event);
  const edits = [{ ref: 1, text: '', cues: [] }, { ref: 3, text: '等复试', cues: ['复试'] }, { ref: 0, text: '惦记搬家', cues: ['搬家'] }];
  const next = updateConcerns(items, visible, edits, event);
  assert.deepEqual(next.map(item => item.text), [hidden.text, '等复试', '惦记搬家']);
  assert.ok(next[1].cues.includes('面试'));
  assert.throws(() => updateConcerns(items, visible, [...edits, { ref: 2, text: '', cues: [] }], event));
  assert.deepEqual(items.map(item => item.text), ['等猫回家', hidden.text, '等面试结果']);
});

test('a vague statement in a fresh chat cannot guess which of two pending matters has closed', async () => {
  const state = { ...newState(), concerns: [concern('等面试结果', '面试'), concern('等猫回家', '找猫')] };
  const read = async messages => {
    assert.ok(messages.every(m => !m.content.includes('面试') && !m.content.includes('找猫')));
    return { usage: {}, message: { tool_calls: [{ function: { arguments: '{"route":"clarify","answer":"是说哪件事结束了？","cues":[]}' } }] } };
  };
  const r = await experience(read, state, [], { text: '终于结束了。', minute: 10 });
  assert.deepEqual(r.state, state);
  assert.equal(r.kind, 'clarify');
});
