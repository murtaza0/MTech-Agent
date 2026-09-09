import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mtechRouter from "./mtech";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mtechRouter);

export default router;
