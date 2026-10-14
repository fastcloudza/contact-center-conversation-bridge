import "dotenv/config";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createS3Client } from "./adapters/amazonConnect/s3.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const s3 = createS3Client(config);

const app = buildServer({ config, s3, logger });

app.listen(config.PORT, () => {
  logger.info("contact-center-conversation-bridge listening", {
    port: config.PORT,
    amazonConnectEnabled: config.AMAZON_CONNECT_ENABLED,
    amazonConnectDemoMode: config.AMAZON_CONNECT_DEMO_MODE,
  });
});
