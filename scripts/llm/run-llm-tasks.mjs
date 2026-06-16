import path from 'node:path';
import { PATHS, readJson, writeJson } from '../shared.mjs';
import { appendLlmError, ensureLlmDirs, getLlmClient, loadLatestReport } from './client.mjs';

async function main() {
  await ensureLlmDirs();
  const { reportDate } = await loadLatestReport(process.argv[2]);
  const taskFile = path.join(PATHS.data, 'llm_candidates', `tasks_${reportDate}.json`);
  const taskPayload = await readJson(taskFile, { tasks: [] });
  const client = await getLlmClient();
  if (!client.enabled) {
    await appendLlmError({ stage: 'llm:run', message: 'LLM补充未运行或失败，待人工补充。', reason: 'LLM_ENABLED=false' });
    console.log('LLM_ENABLED=false; skipped API calls.');
    return;
  }
  const outputs = [];
  for (const task of taskPayload.tasks || []) {
    try {
      outputs.push(await client.runJson(task));
    } catch (error) {
      await appendLlmError({ stage: 'llm:run', task_type: task.task_type, ticker: task.ticker, message: error.message });
    }
  }
  await writeJson(path.join(PATHS.data, 'llm_candidates', `outputs_${reportDate}.json`), { report_date: reportDate, outputs });
  console.log(`LLM outputs written: data/llm_candidates/outputs_${reportDate}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
