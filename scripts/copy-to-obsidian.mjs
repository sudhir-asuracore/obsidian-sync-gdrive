import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

const manifestPath = path.resolve("manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("Error: manifest.json not found.");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pluginId = manifest.id;
const distDir = path.resolve("dist", pluginId);

// Get destination directory from environment variable
const destDir = process.env.OBSIDIAN_PLUGIN_DEST;

if (!destDir) {
  console.error("Error: OBSIDIAN_PLUGIN_DEST is not defined in .env file.");
  process.exit(1);
}

if (!fs.existsSync(distDir)) {
  console.error(`Error: ${distDir} does not exist. Run "npm run package" first.`);
  process.exit(1);
}

// Ensure destination directory exists
if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

console.log(`Deploying to: ${destDir}`);

try {
  const files = fs.readdirSync(distDir);
  for (const name of files) {
    const src = path.join(distDir, name);
    const dst = path.join(destDir, name);
    fs.copyFileSync(src, dst);
    console.log(`- Copied ${name}`);
  }
  console.log(`\nSuccessfully deployed "${pluginId}"`);
} catch (err) {
  console.error("Error copying files:", err);
  process.exit(1);
}
