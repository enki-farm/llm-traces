import { execFile } from 'node:child_process';
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const distPath = path.join(projectRoot, 'dist');
const zipPath = path.join(projectRoot, 'dist.zip');
const pluginJson = JSON.parse(await readFile(path.join(projectRoot, 'src/plugin.json'), 'utf8'));

if (!pluginJson.id || path.basename(pluginJson.id) !== pluginJson.id) {
  throw new Error('src/plugin.json must define a valid plugin ID');
}

await access(path.join(distPath, 'plugin.json'));

const tempRoot = await mkdtemp(path.join(tmpdir(), 'grafana-plugin-dist-'));

try {
  await cp(distPath, path.join(tempRoot, pluginJson.id), { recursive: true });
  await rm(zipPath, { force: true });
  await execFileAsync('zip', ['-qr', zipPath, pluginJson.id], { cwd: tempRoot });
  console.log(`Created ${path.relative(projectRoot, zipPath)}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}