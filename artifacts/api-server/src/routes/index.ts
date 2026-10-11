import { Router, type IRouter } from "express";
import healthRouter from "./health";
import forecastsRouter from "./forecasts";
import probeLogRouter from "./probeLog";
import edgarRouter from "./edgar";

const router: IRouter = Router();

router.use(healthRouter);
router.use(forecastsRouter);
router.use(probeLogRouter);
router.use(edgarRouter);

export default router;
