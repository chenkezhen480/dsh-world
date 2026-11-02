declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-world-history': { kind: 'dsh-world-history'; form: 'recall' };
    'dsh-world-summary-input': { kind: 'dsh-world-summary-input' };
    'dsh-world-life': { kind: 'dsh-world-life' };
    /** 她图谱里的卡片：消息里提到她记过的名字时追加，压缩后重来，不进归档。 */
    'dsh-world-channel-context': { kind: 'dsh-world-channel-context'; form: 'recall'; forMessageId?: import('@deepseek-ai/dsh-llm').MessageId };
    /** 门外有程序敲了一下门（阳台那条线）：「外面有人等着」，不是谁发来的话。 */
    'dsh-world-outside': { kind: 'dsh-world-outside'; form: 'ring' };
  }
}
export {};
