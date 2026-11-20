import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { quotePowerShell } from '../src/powershell.ts';

const samples = ["C:\\Users\\O'Neil\\.dsh", 'C:\\Users\\O\u2019Neil\\.dsh', 'a\u2018b\u201Ac\u201Bd', "end\u2019; Write-Output INJECTED; '", '$env:TEMP `n'];

test('every single quote PowerShell knows is doubled, the curly ones too', () => {
  assert.equal(quotePowerShell("O'Neil"), "'O''Neil'");
  assert.equal(quotePowerShell('O\u2019Neil'), "'O\u2019\u2019Neil'");
});

test('PowerShell reads each quoted text back exactly, with nothing run or expanded', { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }, () => {
  for (const sample of samples) {
    const script = `$v = ${quotePowerShell(sample)}; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
    assert.equal(Buffer.from(out.trim(), 'base64').toString('utf8'), sample);
  }
});
