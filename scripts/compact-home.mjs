#!/usr/bin/env node
// Asks a running world to compact her home conversation once (held behind her running turn).
// Needs `bridge: true` in the plugin config. Usage: node scripts/compact-home.mjs [world directory]
// The world directory defaults to $DSH_WORLD_DIR, then ~/.dsh/worlds/<the only world there>.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function worldDir() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.DSH_WORLD_DIR) return process.env.DSH_WORLD_DIR;
  const root = join(homedir(), '.dsh', 'worlds');
  const worlds = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  if (worlds.length !== 1) throw new Error(`找不到唯一的世界目录，请把路径作为参数传入（在 ${root} 下找到 ${worlds.length} 个）`);
  return join(root, worlds[0]);
}

try {
  const file = join(worldDir(), 'bridge.json');
  if (!existsSync(file)) throw new Error(`没有 ${file}：世界没有在运行，或者没有开启 bridge`);
  const { origin, token } = JSON.parse(readFileSync(file, 'utf8'));
  const response = await fetch(new URL('/dsh-world/bridge/compact', origin), { method: 'POST', headers: { 'x-dsh-world-token': token }, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (response.status === 202) console.log('已请求压缩家会话；她正在忙的话会等这一轮结束后再压缩。');
  else { console.error(`没有受理（${response.status}）：${body.error ?? '未知原因'}`); process.exitCode = 1; }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
