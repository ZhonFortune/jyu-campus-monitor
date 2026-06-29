import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, ".cloudbase", "functions", "powerfee-cron");
const sourceDistDir = path.join(rootDir, "dist");
const targetDistDir = path.join(outputDir, "dist");
const sourceEntry = path.join(sourceDistDir, "cloudbase", "powerfee-cron.js");

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

if (!(await fileExists(sourceEntry))) {
  throw new Error("dist/cloudbase/powerfee-cron.js is missing. Run npm run build before preparing the CloudBase function.");
}

const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const functionPackageJson = {
  name: "powerfee-cron",
  version: packageJson.version,
  private: true,
  type: "module",
  main: "index.js",
  dependencies: packageJson.dependencies ?? {}
};

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(sourceDistDir, targetDistDir, { recursive: true });
await writeFile(
  path.join(outputDir, "index.js"),
  'export { main } from "./dist/cloudbase/powerfee-cron.js";\n',
  "utf8"
);
await writeFile(path.join(outputDir, "package.json"), `${JSON.stringify(functionPackageJson, null, 2)}\n`, "utf8");
