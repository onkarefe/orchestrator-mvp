import { Router } from 'express';
import pool from '../db/connection.js';

const router = Router();
let shuttingDown = false;

export function setServiceShuttingDown(value = true) {
  shuttingDown = Boolean(value);
}

export function liveness(req, res) {
  res.json({ ok: true, service: 'orchestrator-mvp' });
}

export async function readiness(req, res, { db = pool } = {}) {
  if (shuttingDown) {
    res.status(503).json({
      ok: false,
      service: 'orchestrator-mvp',
      reason: 'shutting_down',
    });
    return;
  }

  try {
    await db.query('SELECT 1 AS ready');
    res.json({ ok: true, service: 'orchestrator-mvp' });
  } catch {
    res.status(503).json({
      ok: false,
      service: 'orchestrator-mvp',
      reason: 'database_unavailable',
    });
  }
}

router.get('/health', liveness);
router.get('/health/live', liveness);
router.get('/health/ready', readiness);

export default router;
