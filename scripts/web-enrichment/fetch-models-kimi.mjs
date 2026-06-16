import { fetchProviderModels } from './fetch-model-provider-common.mjs';

fetchProviderModels('kimi').catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
