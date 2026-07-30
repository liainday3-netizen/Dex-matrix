import { Router, type IRouter } from "express";
import healthRouter from "./health";
import scannerRouter from "./scanner";
import marketRouter from "./market";
import traderRouter from "./trader";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scannerRouter);
router.use(marketRouter);
router.use(traderRouter);

export default router;
