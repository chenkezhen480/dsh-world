// src/ecosystem/computer/desktop/processes.ts
import { execFile } from 'node:child_process';

/**
 * Whether a program with this executable name is running, windows or not: WeChat closed to the tray has none, and
 * launching it then would open a second copy.
 */
export function isRunning(executable: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${executable}.exe`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(new Error(`查不到 ${executable} 有没有在运行：${error.message}`));
      resolve(stdout.toLowerCase().includes(`"${executable.toLowerCase()}.exe"`));
    });
  });
}
