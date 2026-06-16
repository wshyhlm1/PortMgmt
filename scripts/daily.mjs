import { spawn } from 'node:child_process';
import path from 'node:path';
import { PATHS } from './shared.mjs';

async function main() {
  await runScript('import-profiles.mjs');
  await runScript('scan-obsidian.mjs');
  await runScript('fetch-market.mjs');
  await runScript('render.mjs');
  await runScript('data-quality.mjs');
  await runScript('build-site.mjs');
  await runScript('validate-report.mjs');

  const deployCode = await runScript('deploy.mjs', [], { allowFailure: true });
  if (deployCode !== 0) {
    console.warn(`Deploy exited with ${deployCode}; local report remains available.`);
  }
}

function runScript(script, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PATHS.reports, '..', 'scripts', script), ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) resolve(code);
      else reject(new Error(`${script} exited with ${code}`));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
