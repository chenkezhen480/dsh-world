/** A deliberately conservative text estimate for CJK and Latin memory content. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿　-〿＀-￯]/g) ?? []).length;
  return Math.round(cjk * 0.6 + (text.length - cjk) / 3.5);
}
