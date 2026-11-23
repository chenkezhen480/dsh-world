import assert from 'node:assert/strict';
import { migrateConcerns, selectConcerns, updateConcerns } from './concerns.mjs';

export const persona = '我是阿澄，在聊天框和熟悉的朋友说话。我说话随意，有自己的喜好，消息长短看事情。只发送实际会打出来的话。这里能发送文字，做事的打算用将来时说，已经发生的事按已知事实说。朋友把选择交给我时，我选一件自己此刻真愿意做的事。平常聊天直接接对方的话。';
const appraisal = `我记录阿澄这一次经历的影响，采用阿澄本人的第一人称。伙伴消息里的“我”指伙伴，“你”指阿澄。独处经历的主体才是阿澄。分清谁做的、是许诺还是已发生。
先单看最新这件事。先前对话只帮助读懂指代。旧期待已经实现，就让它结束，勿顺势抬高要求。选择如何使用已有的精力不会补充它。只根据这次有证据的变化填写记录。
这次的牵挂候选由话题线索找出，可能不相关。只处理最新输入确实改变的事。对方明确说还有后续、仍然在等待的重要事情，单独记一条，即使 present 是空的。新增另一件事另起一条；完成或解除对应等待就关闭它。每条只写它自身，别夹带其他事情。没有新进展就不改，别把历史里提过的事重新建档。只有需要带进当下的旧事才选择回想。空闲时看到 due 只表示一个合适的时机；是否想问由我决定。
调用 record_experience，分别判断此刻、以后遇到同一件事、过一会儿遇到别的事。这三者可同时成立。`;

export function newState() {
  return { concerns: [], energy: '', energyAt: null };
}

export function atTime(state, minute) {
  state = migrateConcerns(state);
  return state.energyAt !== null && minute - state.energyAt >= 120
    ? { ...state, energy: '', energyAt: null } : { ...state };
}

export function applyChange(state, change, minute) {
  for (const key of ['energy', 'present']) {
    assert.ok(change[key] === undefined || typeof change[key] === 'string', '无效状态字段 ' + key);
  }
  const next = { ...state };
  if (change.energy !== undefined && change.energy !== state.energy) {
    next.energy = change.energy;
    next.energyAt = change.energy ? minute : null;
  }
  return next;
}

export const user = content => ({ role: 'user', content });
export const system = content => ({ role: 'system', content });
const readTurn = { name: 'read_turn', description: '先识别值得记录的新经历、期待、担心或近况，哪怕是第一次听说也要交给 look_back，随后再回应。',
  parameters: { type: 'object', properties: {
    route: { type: 'string', enum: ['answer', 'lookup', 'look_back', 'clarify'], description: 'look_back：伙伴在分享生活中具体的期待、顾虑、事件结果、值得挂念的新经历，或者请我自己拿主意；能给出一句安慰也要走此路。answer 只用于普通寒暄、纯知识问题、收尾。lookup 用于只需核对前文的事实。clarify 用于泛指某件事、缺少可辨认的线索。' },
    cues: { type: 'array', items: { type: 'string' }, description: '当前原话中的对象、事件，以及从具体措辞可推断的场合和常见称呼。可给多个可能的场合供检索核对，不要断言猜测。只有泛指结果时留空。' },
    answer: { type: 'string', description: 'answer 时写自然回复。clarify 时简短询问所指，勿编造前情。其他留空。' },
  }, required: ['route', 'cues', 'answer'] } };
const editsField = { type: 'array', description: '仅列确有变化的事项。没有变化或只有一时感慨填 []。不要维护对话待办清单。', items: {
  type: 'object', properties: {
    ref: { type: 'integer', description: '同一件事用候选的编号。新事情填 0。' },
    text: { type: 'string', description: '一句第一人称，留下此事具体对我意味着什么。已经解决的旧事放进 resolved，不再写入此处。' },
    quote: { type: 'string', description: '从最新输入逐字摘出只与这一件事有关的短句。' },
    cues: { type: 'array', items: { type: 'string' }, description: '能在以后说回同一件事时认出它的具体称呼、主体或同义词。' },
    timeQuote: { type: 'string', description: '原话给出或撤销这件事的后续时间时，摘录对应的原文，否则留空。' },
    afterMinutes: { type: 'integer', description: '按此刻本地时间计算：约好稍后再聊或等待一个已知时间的结果，填距合适时机的正整数分钟。无时间依据填 0 且 timeQuote 留空。只有原话撤销旧时间才填 -1。' },
  }, required: ['ref', 'text', 'quote', 'cues', 'timeQuote', 'afterMinutes'] } };
const record = { name: 'record_experience', description: '分别记录这次经历对当前反应、长期牵挂和短期精力的影响。',
  parameters: { type: 'object', properties: {
    kind: { type: 'string', enum: ['standalone', 'reply', 'closing', 'choice'], description: 'standalone：这句话单独即能理解、前面的对话对答它没有帮助。reply：需要前文来理解指代、延续事项或答复具体邀约。closing：简单收尾。choice：自由安排做哪件事。' },
    recalls: { type: 'array', items: { type: 'integer' }, description: '确实与眼前有关、想带进回应的候选编号。线索不足或不想提就填 []。' },
    resolved: { type: 'array', items: { type: 'integer' }, description: '这次已实际兑现、确认安全或已经结束的等待分别是哪几个编号？这些等待从牵挂里移除。没有填 []。' },
    edits: editsField,
    energy: { type: 'string', description: '此事过后，去做别的事还剩多少兴致或力气？本人刚做完一件费力或振奋的事，应留下对此的真实判断。写当下能投入多少，不记事项名。无变化填 =，消散填空串。' },
    present: { type: 'string', description: '这次新发生了什么使我有感触？只有真的被触动才写一句，不拟台词。普通消息填空串。' },
  }, required: ['kind', 'recalls', 'resolved', 'edits', 'energy', 'present'], additionalProperties: false } };

export async function experience(complete, state, history, event) {
  if (event.kind === 'tool-step') return { state, change: {}, calls: [] };
  // In DSH the world owns the identity and the final tool-capable reply.
  if (event.host) {
    const send = complete;
    complete = (messages, options) => send(messages.map(m => m.role === 'system'
      ? { ...m, content: m.content.replace(persona, event.host.persona).replaceAll('阿澄', event.host.name) }
      : m), options);
  }
  const prior = atTime(state, event.minute);
  const calls = [];
  let cues = [];
  let previousTopic = [];
  if (event.kind !== 'private' && event.kind !== 'wake') {
    // Decide whether the latest message needs personal history before old feelings can color that decision.
    const pending = prior.concerns.length ? ' 我此前留有个人牵挂。若对方正在告诉我自己实际做了什么或结果如何，要先读取前情，才能知道这件事对我意味着什么。' : '';
    const triage = await complete([system(persona + '\n先判断这一句是否带来值得记住的新经历，或者在讲之前某件事的新进展。这两种都走 look_back，即使我单听这句话就知道该怎么回。问到我本人的愿望、偏好，或把接下来做什么交给我选，也走 look_back。' + pending), user(event.text)],
      { tools: [{ type: 'function', function: readTurn }], tool_choice: { type: 'function', function: { name: readTurn.name } } });
    calls.push(callMetrics(triage));
    const args = JSON.parse(triage.message.tool_calls[0].function.arguments);
    assert.ok(['answer', 'lookup', 'look_back', 'clarify'].includes(args.route));
    if (args.route === 'clarify') {
      const previous = history.findLast(m => m.role === 'user');
      if (previous) previousTopic = selectConcerns(prior.concerns, [], { ...event, text: previous.content }, event.concernTokenBudget, true);
    }
    if (args.route === 'answer' || (args.route === 'clarify' && previousTopic.length !== 1)) {
      const kind = args.route === 'answer' ? 'direct' : 'clarify';
      if (event.host) return { state: prior, change: {}, kind, calls,
        ...(kind === 'clarify' ? { context: '我还拿不准对方说的是哪件事，可以先确认一下。' } : {}) };
      assert.ok(args.answer?.trim());
      return { state: prior, change: {}, kind, recalls: [], calls, reply: args.answer };
    }
    if (args.route === 'lookup') {
      if (event.host) return { state: prior, change: {}, kind: 'lookup', calls };
      const response = await complete([system(persona + '\n对方问的是眼前的实际事情。用前文核准提到的对象、尺寸和事实，直接接这句话。'), ...history, user(event.text)]);
      assert.ok(response.message.content?.trim());
      calls.push(callMetrics(response));
      return { state: prior, change: {}, kind: 'lookup', recalls: [], calls, reply: response.message.content };
    }
    assert.ok(Array.isArray(args.cues) && args.cues.every(cue => typeof cue === 'string'), '缺少话题线索');
    cues = args.cues;
  }
  const visible = previousTopic.length === 1 ? previousTopic : selectConcerns(prior.concerns, cues, event, event.concernTokenBudget);
  const input = [system(persona + '\n' + appraisal), user(JSON.stringify({
    最近的对话: history.slice(-2).map(m => [m.role === 'assistant' ? (event.host?.name ?? '阿澄') : '伙伴', m.content]),
    此刻本地时间: new Date(event.minute * 60000).toLocaleString('zh-CN'), ...(visible.length ? { 相关牵挂: visible } : {}), 尚有的余感: prior.energy,
    [event.kind === 'private' ? '本人独处时发生' : event.kind === 'wake' ? '本人的自由时间' : '伙伴此刻的原话']: event.text }))];
  for (let attempt = 0; ; attempt++) {
    const privateEvent = event.kind === 'private';
    const definition = privateEvent ? privateRecord : record;
    const judged = await complete(input, { tools: [{ type: 'function', function: definition }],
      tool_choice: { type: 'function', function: { name: record.name } }, temperature: 0.2 });
    calls.push(callMetrics(judged));
    let change, next, kind, recalls;
    try {
      const actions = judged.message.tool_calls;
      assert.equal(actions?.length, 1);
      assert.equal(actions[0].function.name, record.name);
      const args = JSON.parse(actions[0].function.arguments);
      kind = privateEvent ? 'private' : args.kind;
      assert.ok(privateEvent || ['standalone', 'reply', 'closing', 'choice'].includes(kind));
      recalls = privateEvent ? [] : args.recalls;
      assert.ok(Array.isArray(recalls) && recalls.every(ref => visible.some(item => item.ref === ref)), '只能回想本轮读到的编号');
      assert.ok(Array.isArray(args.edits), '缺少牵挂变更列表');
      assert.ok(Array.isArray(args.resolved) && args.resolved.every(ref => visible.some(item => item.ref === ref)), '只能结束本轮读到的编号');
      assert.ok(args.edits.every(edit => args.resolved.includes(edit.ref) || (typeof edit.text === 'string' && edit.text.trim())),
        '新增或修改需要正文，已解决的编号写入 resolved');
      change = {};
      for (const key of ['energy', 'present']) {
        if (privateEvent && key === 'present') continue;
        assert.equal(typeof args[key], 'string', '无效字段 ' + key);
        if (kind === 'closing' || (kind === 'choice' && key === 'energy' && event.kind !== 'private')) continue;
        if (args[key] === '=' || (key === 'present' && !args[key])) continue;
        change[key] = args[key];
      }
      if (!privateEvent && !change.present) delete change.energy;
      const edits = event.kind === 'wake' ? [] : [
        ...args.resolved.map(ref => ({ ref, text: '', cues: [] })),
        ...args.edits.filter(edit => kind !== 'closing' && !args.resolved.includes(edit.ref)),
      ];
      next = applyChange(prior, change, event.minute);
      next.concerns = updateConcerns(prior.concerns, visible, edits, event);
      if (edits.length) change.edits = edits;
    } catch (error) {
      if (attempt >= 2) throw error;
      input[0] = system(input[0].content + '\n上次工具参数无效，请修正：' + error.message);
      continue;
    }
    const result = { state: next, kind, change, calls, recalls, visible };
    if (event.kind === 'private') return result;
    const remembered = visible.filter(item => recalls.includes(item.ref)).map(item => item.text);
    const past = kind !== 'closing' && remembered.length ? '\n我记得自己之前的经历：' + remembered.join('\n') : '';
    const disposition = change.present ? '\n我眼下的感受：' + change.present : '';
    const visibleHistory = kind === 'standalone' ? [] : kind === 'closing' ? history.slice(-2) : history;
    const focus = kind === 'closing' ? '\n对方在收住刚才的话题，一句自然的回应就好。' :
      (!recalls.length && !change.present && kind === 'reply' ? '\n接住眼前这句话本身，别替对方猜提问的动机。' : '');
    const speaker = event.kind === 'wake' ? '现在是我自己的空闲时间。用一句话记下我此刻自己决定怎么过。\n' : '';
    let decision = '';
    if (kind === 'choice' || event.kind === 'wake') {
      const plan = await complete([system('你就是阿澄。根据眼前事实和自己的状态，决定这段时间具体用来做什么。现有的劲头可以用在真正需要投入的事上，也可以给自己留出缓冲。选一件此刻最想做且现实可行的事，只用一句话记下自己的决定，不列选项，不写聊天台词。'),
        user(JSON.stringify({ 我的自述: event.host?.self, 最近的对话: visibleHistory, 眼前: event.text, 我的余力和兴致: prior.energy, 相关经历: past, 眼下的感受: change.present ?? '' }))]);
      assert.ok(plan.message.content?.trim());
      calls.push(callMetrics(plan));
      result.intention = plan.message.content;
      decision = '\n我刚做的决定：' + result.intention + '\n现在把自己的决定告诉朋友。';
    }
    if (event.host) return { ...result, context: [past.trim(), disposition.trim(), result.intention && '我刚才自己的打算：' + result.intention].filter(Boolean).join('\n') };
    const reply = await complete([system(persona + focus + past + decision + disposition), ...visibleHistory, user(speaker + event.text)]);
    assert.ok(reply.message.content?.trim(), '回复为空');
    calls.push(callMetrics(reply));
    return { ...result, reply: reply.message.content };
  }
}

export function callMetrics({ model, usage, ms }) {
  return { model, input: usage.prompt_tokens, output: usage.completion_tokens, ms };
}

const privateRecord = { name: record.name, description: '写下独处经历留下的个人印象与余力。两项各自独立。',
  parameters: { type: 'object', properties: {
    edits: editsField, resolved: record.parameters.properties.resolved, energy: record.parameters.properties.energy,
  }, required: ['edits', 'resolved', 'energy'], additionalProperties: false } };
