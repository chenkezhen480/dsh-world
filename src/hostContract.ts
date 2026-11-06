declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'agent-preset/selected': { agentPreset: string };
  }
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap { compaction: true; }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-world-history': { kind: 'dsh-world-history'; form: 'recall'; worldId?: string };
    'dsh-world-summary-input': { kind: 'dsh-world-summary-input' };
    'dsh-world-life': { kind: 'dsh-world-life' };
    'dsh-world-channel-context': { kind: 'dsh-world-channel-context'; form: 'recall'; forMessageId?: import('@deepseek-ai/dsh-llm').MessageId };
    /** 门外有程序敲了一下门（阳台那条线）：「外面有人等着」，不是谁发来的话。 */
    'dsh-world-outside': { kind: 'dsh-world-outside'; form: 'ring' };
    /** QQ 的一轮完成了却没说出能发的话：提醒她对方还在等，不是谁发来的话，不进归档。 */
    'dsh-world-reply-nudge': { kind: 'dsh-world-reply-nudge' };
  }
}
export {};
