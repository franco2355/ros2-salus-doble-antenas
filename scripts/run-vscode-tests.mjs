import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

async function main() {
  const extensionDevelopmentPath = repoRoot;
  const extensionTestsPath = path.resolve(repoRoot, "src/test-extension/suite/index.cjs");
  const launchArgs = ["--disable-extensions", "--disable-workspace-trust"];

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs
  });
}

main().catch((error) => {
  console.error("Failed to run VSCode integration tests");
  console.error(error);
  process.exit(1);
});
