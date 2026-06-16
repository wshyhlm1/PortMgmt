import path from 'node:path';
import { PATHS, readJson, writeJson } from '../shared.mjs';
import { ensureLlmDirs, loadEnv, loadLatestReport } from './client.mjs';

async function main() {
  await loadEnv();
  await ensureLlmDirs();
  const { reportDate, report } = await loadLatestReport(process.argv[2]);
  const valuationTasks = report.valuation_tasks || (await readJson(path.join(PATHS.data, 'valuation_tasks', `${reportDate}.json`), { tasks: [] })).tasks || [];
  const tasks = [
    ...valuationTasks.map((task) => ({
      task_type: 'valuation_gap_prompt',
      ticker: task.ticker,
      input: task,
      required_output: task.required_output_schema,
    })),
    ...(report.obsidian_hits || []).slice(0, 80).map((hit) => ({
      task_type: 'library_summary',
      ticker: hit.ticker_key || hit.ticker,
      input: hit,
      required_output: {
        task_type: 'library_summary',
        ticker: 'string',
        keep: 'boolean',
        date: 'YYYY-MM-DD',
        title_clean: 'string',
        summary: 'string',
        core_view: 'string',
        confidence: 'high|medium|low',
        reasons: 'string[]',
      },
    })),
  ];
  await writeJson(path.join(PATHS.data, 'llm_candidates', `tasks_${reportDate}.json`), {
    report_date: reportDate,
    llm_enabled: /^true$/i.test(process.env.LLM_ENABLED || 'false'),
    tasks,
  });
  console.log(`LLM tasks written: data/llm_candidates/tasks_${reportDate}.json (${tasks.length} tasks, API not called)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
