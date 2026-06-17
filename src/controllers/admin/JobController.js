import { listArtifacts } from '../../models/ArtifactModel.js';
import { findJobById, listJobs } from '../../models/JobModel.js';
import { listLogs } from '../../models/LogModel.js';

function prettyJson(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  return JSON.stringify(value, null, 2);
}

function renderPage(res, next, view, data) {
  res.render(view, data, (pageError, body) => {
    if (pageError) {
      next(pageError);
      return;
    }

    res.render('layouts/main', { title: data.title, body });
  });
}

const JobController = {
  async index(req, res, next) {
    try {
      const title = 'Jobs';
      const jobs = await listJobs({ limit: 50, offset: 0 });

      renderPage(res, next, 'pages/jobs', { title, jobs });
    } catch (error) {
      next(error);
    }
  },

  async show(req, res, next) {
    try {
      const job = await findJobById(req.params.id);

      if (!job) {
        res.status(404).send('Job not found');
        return;
      }

      const title = `Job #${job.id}`;
      const logs = await listLogs({ jobId: job.id, limit: 100, offset: 0 });
      const artifacts = await listArtifacts({ jobId: job.id, limit: 100, offset: 0 });

      renderPage(res, next, 'pages/job-detail', {
        title,
        job,
        logs,
        artifacts,
        rawPayloadJson: prettyJson(job.raw_payload_json),
      });
    } catch (error) {
      next(error);
    }
  },
};

export default JobController;
