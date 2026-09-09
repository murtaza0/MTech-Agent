import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// The implicit `workspace` is the MTech platform checkout used to host the
// control plane. It is not a user project, so its platform source tree must
// never appear in the Files/Editor surface. User-created projects are stored
// under the isolated projects root and continue through the normal router.
app.use("/api/mtech/projects/workspace/files", (_req, res) => {
  res.status(404).json({ error: { code: "MTECH_SYSTEM_WORKSPACE", message: "Platform source files are not exposed as a user workspace." } });
});
app.use("/api/mtech/projects/workspace/download.zip", (_req, res) => {
  res.status(404).json({ error: { code: "MTECH_SYSTEM_WORKSPACE", message: "Platform source files are not exposed as a user workspace." } });
});

app.use("/api", router);

export default app;
