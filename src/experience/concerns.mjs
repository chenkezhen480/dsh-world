import assert from 'node:assert/strict';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const fold = text => text.normalize('NFKC').toLowerCase().trim();
const words = text => Array.from(segmenter.segment(fold(text))).filter(part => part.isWordLike).map(part => part.segment);

export function migrateConcerns(state) {
  if (Array.isArray(state.concerns)) return state;
  const { concern, ...rest } = state;
  assert.equal(typeof concern, 'string', '无法读取旧牵挂');
  const cues = [...new Set(words(concern))];
  return { ...rest, concerns: concern ? [{ text: concern, cues, revisitAt: null }] : [] };
}

// The budget covers the serialized personal excerpts. UTF-8 bytes conservatively bound byte-token input.
export function selectConcerns(items, cues, event, budget = Number(process.env.DSH_MOOD_CONCERN_TOKENS ?? 1024), requireUnique = false) {
  assert.ok(Number.isSafeInteger(budget) && budget >= 0, '牵挂 token 预算必须是非负整数');
  const query = fold(event.text);
  const terms = [...new Set(cues.map(fold).filter(Boolean))];
  const ranked = [];
  for (const [index, item] of items.entries()) {
    const keys = item.cues.map(fold);
    const matches = terms.filter(term => keys.some(key => key === term || (term.length > 1 && key.includes(term)))).length;
    const exact = keys.filter(term => term && (item.source || term.length > 1) && query.includes(term)).length;
    const due = event.kind === 'wake' && item.revisitAt != null && item.revisitAt <= event.minute;
    if (event.kind === 'wake' ? due : matches || exact) {
      ranked.push({ ref: index + 1, text: item.source ? item.text + '\n' + item.source : item.text, score: matches + exact, due, at: item.revisitAt });
    }
  }
  if (requireUnique && ranked.length !== 1) return [];
  ranked.sort((a, b) => b.score - a.score || Number(b.due) - Number(a.due) || (a.at ?? Infinity) - (b.at ?? Infinity) || a.ref - b.ref);
  const selected = [];
  let bytes = 2; // brackets and commas belong to the allowance too
  for (const { ref, text, due } of ranked) {
    const entry = { ref, text, ...(due ? { due: true } : {}) };
    const remaining = budget - bytes - Number(selected.length > 0);
    if (Buffer.byteLength(JSON.stringify(entry)) > remaining) {
      if (Buffer.byteLength(JSON.stringify({ ...entry, text: '…' })) >= remaining) continue;
      const chars = Array.from(text);
      let lo = 0, hi = chars.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Buffer.byteLength(JSON.stringify({ ...entry, text: chars.slice(0, mid).join('') + '…' })) <= remaining) lo = mid;
        else hi = mid - 1;
      }
      if (!lo) continue;
      entry.text = chars.slice(0, lo).join('') + '…';
    }
    bytes += Buffer.byteLength(JSON.stringify(entry)) + Number(selected.length > 0);
    selected.push(entry);
  }
  return selected;
}

export function updateConcerns(items, visible, edits, event) {
  assert.ok(Array.isArray(edits), '牵挂变更必须是列表');
  const allowed = new Set(visible.map(entry => entry.ref));
  const next = [...items], touched = new Set();
  // An idle opportunity is offered once. The concern itself stays available for a later conversation.
  for (const { ref, due } of visible) if (due) next[ref - 1] = { ...next[ref - 1], revisitAt: null };
  for (const { ref, text, cues, quote, timeQuote = '', afterMinutes = 0 } of edits) {
    assert.ok(ref === 0 || (allowed.has(ref) && !touched.has(ref)), '只能修改本次读到的牵挂，每条限一次');
    assert.equal(typeof text, 'string');
    if (ref) touched.add(ref);
    if (!text.trim()) {
      assert.ok(ref, '结束牵挂需要已有编号');
      next[ref - 1] = null;
      continue;
    }
    assert.ok(Array.isArray(cues) && cues.length && cues.every(cue => typeof cue === 'string' && cue.trim()), '需要具体检索线索');
    assert.ok(Number.isSafeInteger(afterMinutes) && afterMinutes >= -1 && typeof timeQuote === 'string');
    assert.ok(!afterMinutes || (timeQuote.trim() && event.text.includes(timeQuote)),
      '设置或取消以后想起的时机，必须复制本轮的时间原话；没有合适时机填 0');
    const old = ref ? next[ref - 1] : undefined;
    const source = typeof quote === 'string' && quote.trim() && event.text.includes(quote)
      ? (event.kind === 'private' ? '当时我的经历：' : '当时伙伴的原话：') + quote : undefined;
    const item = { text: text.trim(), ...(source ? { source } : {}),
      cues: [...new Set([...(old?.cues ?? []), ...cues.map(fold), ...cues.flatMap(words).filter(term => term.length > 1)])],
      revisitAt: afterMinutes > 0 ? event.minute + afterMinutes : afterMinutes === -1 ? null : old?.revisitAt ?? null };
    if (ref) next[ref - 1] = item;
    else if (!next.some(existing => existing?.text === item.text)) next.push(item);
  }
  return next.filter(Boolean);
}
