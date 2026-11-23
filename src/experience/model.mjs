import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function deepSeekConfig() {
  const database = new DatabaseSync(join(homedir(), '.cc-switch', 'cc-switch.db'), { readOnly: true });
  let env;
  try {
    const row = database.prepare('SELECT settings_config FROM providers WHERE app_type = ? AND name = ? LIMIT 1').get('claude', 'DeepSeek');
    if (!row) throw new Error('CC Switch 中没有 Claude / DeepSeek 配置');
    env = JSON.parse(row.settings_config).env;
  } finally {
    database.close();
  }
  const origin = new URL(env.ANTHROPIC_BASE_URL).origin;
  const model = env.ANTHROPIC_MODEL.replace(/\[1m\]$/i, '');
  if (origin !== 'https://api.deepseek.com' || !env.ANTHROPIC_AUTH_TOKEN) throw new Error('需要 DeepSeek 官方地址与密钥');
  return { model, apiKey: env.ANTHROPIC_AUTH_TOKEN };
}

export function connectModel() {
  const { model, apiKey } = deepSeekConfig();
  return officialModel(model, apiKey);
}

export function officialModel(model, apiKey) {
  /** @param {any[]} messages @param {object} [options] @param {AbortSignal} [signal] */
  return async function complete(messages, options = {}, signal = undefined) {
    const body = JSON.stringify({ model, messages, thinking: { type: 'disabled' }, temperature: 0.7, max_tokens: 600, ...options });
    const start = performance.now();
    for (let attempt = 0; ; attempt++) {
      const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', redirect: 'error',
        headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
        body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.arrayBuffer();
        await delay(1000 * (attempt + 1), undefined, { signal });
        continue;
      }
      if (!response.ok) throw new Error('DeepSeek HTTP ' + response.status);
      const result = await response.json();
      const choice = result.choices[0];
      if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('DeepSeek finish_reason=' + choice.finish_reason);
      return { message: choice.message, usage: result.usage, model: result.model, ms: Math.round(performance.now() - start) };
    }
  };
}
