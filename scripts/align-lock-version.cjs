const fs = require('fs');
const { execSync } = require('child_process');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lockPath = 'package-lock.json';
const knownGood = '51ba1e123f4a23c3762d8b39d13821f85beeb980';

function readLock() {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

let lock = readLock();
const hasElectron = Boolean(lock.packages && lock.packages['node_modules/electron']);
if (!hasElectron) {
  const raw = execSync(`git show ${knownGood}:package-lock.json`, {
    encoding: 'utf8',
    maxBuffer: 20_000_000,
  });
  lock = JSON.parse(raw);
}

lock.version = pkg.version;
if (lock.packages && lock.packages['']) {
  lock.packages[''].name = pkg.name;
  lock.packages[''].version = pkg.version;
}

fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`lockfile aligned to ${pkg.version}`);
