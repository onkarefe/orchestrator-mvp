import 'dotenv/config';

import app from './app.js';
import env from './config/env.js';
import {
  getSafeStartupConfigSummary,
  validateServerStartupEnv,
} from './config/startupValidation.js';

validateServerStartupEnv();

const port = env.PORT;

console.log(
  'Startup safety config:',
  JSON.stringify(getSafeStartupConfigSummary())
);

app.listen(port, () => {
  console.log(`Orchestrator MVP listening on port ${port}`);
});
