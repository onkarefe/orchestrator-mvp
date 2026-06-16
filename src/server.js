import 'dotenv/config';

import app from './app.js';

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Orchestrator MVP listening on port ${port}`);
});
