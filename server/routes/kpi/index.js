// KPI module router. Split by resource so each file stays readable and the
// permission story for each resource lives next to its handlers.
const express = require('express');
const router  = express.Router();

router.use('/templates',  require('./templates'));
router.use('/scores',     require('./scores'));
router.use('/reviews',    require('./reviews'));
router.use('/inputs',     require('./inputs'));
router.use('/dashboard',  require('./dashboards'));
router.use('/reports',    require('./reports'));

module.exports = router;
