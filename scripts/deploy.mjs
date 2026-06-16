import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PATHS, pathExists } from './shared.mjs';

async function main() {
  const env = await readLocalEnv();
  const host = env.DEPLOY_HOST;
  const deployPath = env.DEPLOY_PATH;
  if (!host || !deployPath) {
    console.log('Deploy skipped: DEPLOY_HOST or DEPLOY_PATH is missing in .env.local.');
    return;
  }

  const date = process.argv[2] || await latestReportDate();
  if (!date) throw new Error('No report date found. Run npm run render first.');
  const localHtml = path.join(PATHS.reports, date, `${date}.html`);
  if (!(await pathExists(localHtml))) throw new Error(`Report not found: portfolio_reports/${date}/${date}.html`);

  const remoteTmp = `/tmp/portmgmt-deploy-${date}.html`;
  await run('scp', [localHtml, `${host}:${remoteTmp}`]);
  const remoteDateFile = `${deployPath.replace(/\/$/, '')}/${date}.html`;
  const remoteIndex = `${deployPath.replace(/\/$/, '')}/index.html`;
  const command = [
    `sudo mkdir -p ${quote(deployPath)}`,
    `sudo mv ${quote(remoteTmp)} ${quote(remoteDateFile)}`,
    `sudo cp ${quote(remoteDateFile)} ${quote(remoteIndex)}`,
    `sudo chown www-data:www-data ${quote(remoteDateFile)} ${quote(remoteIndex)}`,
  ].join(' && ');
  await run('ssh', [host, command]);
  console.log(`Deployed ${date} to ${host}:${deployPath}`);
}

async function readLocalEnv() {
  const file = path.join(PATHS.reports, '..', '.env.local');
  if (!(await pathExists(file))) return {};
  const text = await fs.readFile(file, 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    const match = clean.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

async function latestReportDate() {
  const entries = await fs.readdir(PATHS.reports, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1) || null;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
