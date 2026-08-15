// install-global.mjs — copy the bridge script (and create the Edge profile
// directory) into the DSH user home so the plugin finds it regardless of
// where the package was installed from.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetDir = join(homedir(), '.dsh', 'gemini-bridge');

mkdirSync(targetDir, { recursive: true });
const source = join(__dirname, '..', 'lib', 'gemini-bridge.mjs');
const target = join(targetDir, 'gemini-bridge.mjs');
copyFileSync(source, target);
console.log('dsh-gemini-bridge: installed bridge to ' + target);
