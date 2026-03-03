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

// Get destination directories from environment variables
const destPrefix = (process.env.OBSIDIAN_PLUGIN_DEST_PREFIX || "").trim();
const destNamesRaw = (process.env.OBSIDIAN_PLUGIN_DEST_NAMES || "").trim();
const destSuffix = (process.env.OBSIDIAN_PLUGIN_DEST_SUFFIX || "").trim();

let destDirs = [];
if (destNamesRaw) {
  destDirs = destNamesRaw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => `${destPrefix}${name}${destSuffix}`);
}

if (destDirs.length === 0 && process.env.OBSIDIAN_PLUGIN_DEST) {
  destDirs = process.env.OBSIDIAN_PLUGIN_DEST.split(",").map((dir) => dir.trim()).filter(Boolean);
}

if (destDirs.length === 0) {
  console.error("Error: OBSIDIAN_PLUGIN_DEST_PREFIX/OBSIDIAN_PLUGIN_DEST_NAMES/OBSIDIAN_PLUGIN_DEST_SUFFIX are not defined in .env file.");
  process.exit(1);
}

if (!fs.existsSync(distDir)) {
  console.error(`Error: ${distDir} does not exist. Run "npm run package" first.`);
  process.exit(1);
}

for (const destDir of destDirs) {
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
    console.log(`Successfully deployed "${pluginId}" to ${destDir}\n`);
  } catch (err) {
    console.error(`Error copying files to ${destDir}:`, err);
  }
}
