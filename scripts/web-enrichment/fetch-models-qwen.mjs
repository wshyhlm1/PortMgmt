import { fetchProviderModels } from './fetch-model-provider-common.mjs';

fetchProviderModels('qwen').catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
