import { listArtifacts } from '../../models/ArtifactModel.js';
import { listFactoryUploadTasks } from '../../models/FactoryUploadTaskModel.js';
import { findJobById, listJobs } from '../../models/JobModel.js';
import { listLogs } from '../../models/LogModel.js';
import { redact } from '../../utils/redact.js';

function prettyJson(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    try {
      return JSON.stringify(redact(JSON.parse(value)), null, 2);
    } catch {
      return '[unparseable_json_string]';
    }
  }

  return JSON.stringify(redact(value), null, 2);
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
      const factoryUploadTasks = jobs.length
        ? await listFactoryUploadTasks({
            jobIds: jobs.map((job) => job.id),
            limit: 100,
            offset: 0,
          })
        : [];
      const safeFactoryUploadTasks = factoryUploadTasks.map((task) =>
        redact(task)
      );
      const factoryUploadByJobId = new Map();

      for (const task of safeFactoryUploadTasks) {
        const jobId = String(task.job_id);

        if (!factoryUploadByJobId.has(jobId)) {
          factoryUploadByJobId.set(jobId, task);
        }
      }
      const jobsWithFactoryUpload = jobs.map((job) => ({
        ...job,
        factory_upload: factoryUploadByJobId.get(String(job.id)) ?? null,
      }));

      renderPage(res, next, 'pages/jobs', {
        title,
        jobs: jobsWithFactoryUpload,
      });
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
      const factoryUploadTasks = (
        await listFactoryUploadTasks({
          jobId: job.id,
          limit: 100,
          offset: 0,
        })
      ).map((task) => redact(task));

      renderPage(res, next, 'pages/job-detail', {
        title,
        job,
        logs,
        artifacts,
        factoryUploadTasks,
        rawPayloadJson: prettyJson(job.raw_payload_json),
      });
    } catch (error) {
      next(error);
    }
  },
};

export default JobController;
