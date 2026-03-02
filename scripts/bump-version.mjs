import fs from 'fs';

const args = process.argv.slice(2);
let explicitVersion = null;
let bumpType = null;

for (let i = 0; i < args.length; i += 1) {
	const arg = args[i];
	if (arg === '--version') {
		explicitVersion = args[i + 1];
		i += 1;
	} else if (arg === '--bump') {
		bumpType = args[i + 1];
		i += 1;
	}
}

const parseVersion = (value) => {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value || '');
	if (!match) {
		throw new Error(`Invalid version: ${value}`);
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3])
	};
};

const bumpVersion = (current, type) => {
	const next = { ...current };
	if (type === 'major') {
		next.major += 1;
		next.minor = 0;
		next.patch = 0;
	} else if (type === 'minor') {
		next.minor += 1;
		next.patch = 0;
	} else {
		next.patch += 1;
	}
	return `${next.major}.${next.minor}.${next.patch}`;
};

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));
const writeJson = (path, data) => fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');

if (!explicitVersion && !bumpType) {
	console.error('Usage: node scripts/bump-version.mjs --version X.Y.Z or --bump [patch|minor|major]');
	process.exit(1);
}

const pkg = readJson('package.json');
const currentVersion = parseVersion(pkg.version);
const nextVersion = explicitVersion ? parseVersion(explicitVersion) : null;
const newVersion = explicitVersion ? `${nextVersion.major}.${nextVersion.minor}.${nextVersion.patch}` : bumpVersion(currentVersion, bumpType || 'patch');

pkg.version = newVersion;
writeJson('package.json', pkg);

if (fs.existsSync('package-lock.json')) {
	const lock = readJson('package-lock.json');
	lock.version = newVersion;
	if (lock.packages && lock.packages['']) {
		lock.packages[''].version = newVersion;
	}
	writeJson('package-lock.json', lock);
}

if (fs.existsSync('manifest.json')) {
	const manifest = readJson('manifest.json');
	manifest.version = newVersion;
	writeJson('manifest.json', manifest);
}

console.log(newVersion);
