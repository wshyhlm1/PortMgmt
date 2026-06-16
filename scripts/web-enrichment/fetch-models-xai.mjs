import { fetchProviderModels } from './fetch-model-provider-common.mjs';

fetchProviderModels('xai').catch((error) => {
  console.error(error.message);
  process.exitCode = 0;
});
