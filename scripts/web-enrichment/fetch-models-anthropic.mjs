import { fetchProviderModels } from './fetch-model-provider-common.mjs';

fetchProviderModels('anthropic').catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
