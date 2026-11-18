// Stands in for win32.ps1: one JSON line in, one out; answers with what it was asked, and acts out failures.
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, op, args } = JSON.parse(line);
  if (op === 'crash') process.exit(3);
  process.stdout.write(`${JSON.stringify(op === 'refuse' ? { id, error: 'window 7 is gone' } : { id, data: { op, args } })}\n`);
});
