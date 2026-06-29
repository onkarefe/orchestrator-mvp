import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import adminRoutes from './routes/admin.routes.js';
import healthRoutes from './routes/health.routes.js';
import webhookRoutes from './routes/webhook.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(rootDir, 'public')));

app.use(webhookRoutes);
app.use(express.json());
app.use(healthRoutes);
app.use(adminRoutes);

app.use((req, res) => {
  res.status(404).send('Not found');
});

export default app;
