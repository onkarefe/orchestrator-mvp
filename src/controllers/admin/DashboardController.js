const DashboardController = {
  index(req, res, next) {
    const title = 'Wandini Orchestrator';

    res.render('pages/dashboard', { title }, (pageError, body) => {
      if (pageError) {
        next(pageError);
        return;
      }

      res.render('layouts/main', { title, body });
    });
  },
};

export default DashboardController;
