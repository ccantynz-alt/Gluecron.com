import { join } from "path";

export const config = {
  get port() {
    return Number(process.env.PORT || 3000);
  },
  get databaseUrl() {
    return process.env.DATABASE_URL || "";
  },
  get gitReposPath() {
    return process.env.GIT_REPOS_PATH || join(process.cwd(), "repos");
  },
  get gatetestUrl() {
    return process.env.GATETEST_URL || "https://gatetest.ai/api/scan/run";
  },
  get crontechDeployUrl() {
    return (
      process.env.CRONTECH_DEPLOY_URL ||
      "https://crontech.ai/api/trpc/tenant.deploy"
    );
  },
};
