import fs from 'node:fs';
import path from 'node:path';

export function readConfig(configPath: string): string {
  return fs.readFileSync(path.resolve(configPath), 'utf-8');
}
