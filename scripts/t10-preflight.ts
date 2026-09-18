import { assertRuntimeConfiguration } from "../src/lib/runtime-config";
import { collectOperationalPreflight } from "../src/lib/operational-controls";

try {
  const configuration = assertRuntimeConfiguration();
  const preflight = collectOperationalPreflight();
  const result = {
    ...preflight,
    configuration: {
      databaseHost: configuration.databaseTarget.url.hostname,
      databaseName: configuration.databaseTarget.name,
      trustedOrigin: configuration.trustedOrigin,
    },
  };
  console.log(JSON.stringify(result));
  if (result.status !== "ready") process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ status: "blocked", issues: [error instanceof Error ? error.message : "T10 预检失败"] }));
  process.exitCode = 2;
}

