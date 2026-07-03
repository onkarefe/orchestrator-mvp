import { findArtifactById, listArtifacts } from '../../models/ArtifactModel.js';

function renderPage(res, next, view, data) {
  res.render(view, data, (pageError, body) => {
    if (pageError) {
      next(pageError);
      return;
    }

    res.render('layouts/main', { title: data.title, body });
  });
}

const ArtifactController = {
  async index(req, res, next) {
    try {
      const title = 'Artifacts';
      const artifacts = await listArtifacts({ limit: 50, offset: 0 });

      renderPage(res, next, 'pages/artifacts', { title, artifacts });
    } catch (error) {
      next(error);
    }
  },

  async show(req, res, next) {
    try {
      const artifact = await findArtifactById(req.params.id);

      if (!artifact) {
        res.status(404).send('Artifact not found');
        return;
      }

      const title = `Artifact #${artifact.id}`;

      renderPage(res, next, 'pages/artifact-detail', { title, artifact });
    } catch (error) {
      next(error);
    }
  },
};

export default ArtifactController;
