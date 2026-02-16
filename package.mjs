import fs from 'fs';
import path from 'path';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const pluginId = manifest.id;
const distDir = path.join('dist', pluginId);

console.log(`Packaging plugin "${pluginId}"...`);

// Ensure dist and dist/plugin-id directories exist
if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist');
}
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

// Files to include in the package
const filesToCopy = ['main.js', 'manifest.json', 'styles.css'];

for (const file of filesToCopy) {
    if (fs.existsSync(file)) {
        fs.copyFileSync(file, path.join(distDir, file));
        console.log(`- Copied ${file}`);
    } else {
        if (file !== 'styles.css') {
            console.error(`Error: ${file} not found!`);
            process.exit(1);
        }
    }
}

// Copy bridge folder if it exists
if (fs.existsSync('bridge')) {
    const bridgeDist = path.join('dist', 'bridge');
    if (!fs.existsSync(bridgeDist)) fs.mkdirSync(bridgeDist, { recursive: true });
    fs.copyFileSync(path.join('bridge', 'index.html'), path.join(bridgeDist, 'index.html'));
    console.log(`- Copied bridge/index.html to dist/bridge/index.html`);
}

console.log(`\nSuccessfully packaged into: ${distDir}`);
console.log(`You can now copy the contents of ${distDir} to your Obsidian vault's plugins folder.`);
