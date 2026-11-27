import { spawn } from 'node:child_process';
import type { Outlet } from '../ecosystem/shared/outlets.ts';

/** reach_out's channels: the system notification where there is one, then every outlet that takes `reach`. */
export interface Notifier {
  toast?(title: string, body: string): Promise<void>;
  outlets: readonly Outlet[];
}
/** System notifications exist on Windows only (WinRT through PowerShell); elsewhere the channel is simply absent. */
export const toastSupported = () => process.platform === 'win32';
const xmlEscapes: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const xml = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[<>&'"]/g, char => xmlEscapes[char]!);
const cap = (text: string, max: number) => { const chars = [...text]; return chars.length > max ? `${chars.slice(0, max).join('')}…` : text; };
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/**
 * The DSH desktop's notification identity (AppUserModelID) differs between builds: newer ones register
 * `com.deepseek.dsh`, older ones Electron's default. Tried in this order, then any Start entry named after DSH.
 */
export const KNOWN_DSH_APP_IDS = ['com.deepseek.dsh', 'electron.app.DeepSeek Harness'] as const;

/**
 * The host runs as plain Node (no Electron Notification), so toasts go through WinRT from PowerShell.
 * PowerShell treats U+2018/2019/201A/201B as single quotes, so no text is ever interpolated: it travels as base64.
 *
 * Windows shows a desktop app's toast only for an identity with a Start menu entry, and for any other identity
 * `Show` still succeeds while nothing appears. So the identity is looked up there (`lookup`), the configured one
 * included, and a missing or switched-off one fails loudly. The identity used is written to stdout.
 */
export function toastScript(appId: string | undefined, title: string, body: string, lookup = true): string {
  const payload = `<toast><visual><binding template="ToastGeneric"><text>${xml(cap(title, 64))}</text><text>${xml(cap(body, 500))}</text></binding></visual></toast>`;
  const decode = (text: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}'))`;
  return [
    // Progress records would reach stderr as CLIXML and bury the reason.
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'",
    'try {',
    '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    `$appId = ${decode(appId ?? '')}`,
    ...lookup ? [
      '$apps = @(Get-StartApps)',
      'if ($appId) {',
      '  if (-not ($apps | Where-Object { $_.AppID -eq $appId })) { throw "开始菜单里没有通知身份 $appId，Windows 不会显示它的通知" }',
      '} else {',
      `  $known = @(${KNOWN_DSH_APP_IDS.map(id => decode(id)).join(', ')})`,
      '  $app = $known | ForEach-Object { $id = $_; $apps | Where-Object { $_.AppID -eq $id } } | Select-Object -First 1',
      "  if (-not $app) { $app = $apps | Where-Object { $_.Name -like '*DeepSeek Harness*' } | Select-Object -First 1 }",
      `  if (-not $app) { throw ${decode(`开始菜单里找不到 DSH 桌面版的通知身份（${KNOWN_DSH_APP_IDS.join(' 或 ')}），Windows 不会显示通知；可在配置里写 toastAppId`)} }`,
      '  $appId = $app.AppID',
      '}',
    ] : [],
    '$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)',
    // As a number: the WinRT enum put into a string sometimes came out empty, so every toast was refused as switched
    // off, with empty brackets for the reason (#72). 0 is Enabled; the rest say who switched it off.
    '$setting = [int]$notifier.Setting',
    "if ($setting -ne 0) { $why = @('', '这个程序的通知被关了', '这个账户的通知被关了', '组策略关了通知', '程序清单不允许通知')[$setting]; throw \"Windows 关闭了 $appId 的通知（$why）\" }",
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml(${decode(payload)})`,
    '$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
    '[Console]::Out.Write($appId)',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  ].join('\n');
}
/** `appId` is the configured identity; without one it is found once and reused while it keeps working. */
export function windowsToast(appId?: string, spawnImpl: typeof spawn = spawn, timeoutMs = 15_000) {
  let found: string | undefined;
  return (title: string, body: string) => new Promise<void>((resolvePromise, reject) => {
    const encoded = Buffer.from(toastScript(found ?? appId, title, body, found === undefined), 'utf16le').toString('base64');
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { found = undefined; reject(error); return; }
      found = stdout.trim() || found;
      resolvePromise();
    };
    const timer = setTimeout(() => { child.kill(); settle(new Error(`系统通知超时（${Math.round(timeoutMs / 1000)} 秒）`)); }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => settle(error));
    child.on('close', code => settle(code === 0 ? undefined : new Error(`powershell 退出码 ${code}：${stderr.trim().slice(0, 200)}`)));
  });
}
