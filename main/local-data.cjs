const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

function createLocalData(home) {
  const configFile = path.join(home, 'local-preferences.json');
  let config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  let lastImport = '';
  const root = () => {
    if (config.storagePath && !fs.statSync(config.storagePath).isDirectory()) throw new Error('数据存储位置不可用');
    return config.storagePath || home;
  };
  const save = (next) => { atomicJson(configFile, next); config = next; };
  const status = () => ({ storagePath: root(), inboxPath: config.inboxPath || '', inboxEnabled: config.inboxEnabled === true, closeAction: config.closeAction === 'edge' ? 'edge' : 'hide', edgeTabY: Number.isFinite(config.edgeTabY) ? config.edgeTabY : null, edgeTabSide: config.edgeTabSide === 'right' || config.edgeTabSide === 'left' ? config.edgeTabSide : '', lastImport });
  function migrate(destination) {
    destination = path.resolve(destination);
    const source = path.resolve(root());
    if (destination.toLowerCase() === source.toLowerCase()) return status();
    if (destination.toLowerCase().startsWith(source.toLowerCase() + path.sep) || source.toLowerCase().startsWith(destination.toLowerCase() + path.sep)) throw new Error('请选择与当前数据目录分开的空文件夹');
    if (fs.readdirSync(destination).length) throw new Error('请选择空文件夹，避免覆盖已有文件');
    function copy(from, to) {
      const stat = fs.lstatSync(from);
      if (stat.isSymbolicLink()) throw new Error('数据目录中存在链接，未切换位置');
      if (stat.isDirectory()) {
        fs.mkdirSync(to);
        for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
      } else {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        if (!fs.readFileSync(from).equals(fs.readFileSync(to))) throw new Error('复制校验失败，仍使用原位置');
      }
    }
    for (const name of ['luma-data.json', 'lifelog.json', 'lifelog-media', 'backups', 'lifelog-imports.json']) {
      if (fs.existsSync(path.join(source, name))) copy(path.join(source, name), path.join(destination, name));
    }
    save({ ...config, storagePath: destination });
    return status();
  }
  function scan() {
    if (!config.inboxEnabled || !config.inboxPath) return status();
    let imported = 0, conflicts = 0, failed = 0;
    try {
      const storeFile = path.join(root(), 'lifelog.json');
      const ledgerFile = path.join(root(), 'lifelog-imports.json');
      const store = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : { version: 1, entries: {} };
      if (!store.entries || typeof store.entries !== 'object' || Array.isArray(store.entries)) throw new Error('日记数据库格式异常');
      const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
      const inbox = fs.realpathSync(config.inboxPath);
      const done = path.join(inbox, 'done');
      for (const name of fs.readdirSync(inbox).filter(n => /^lifelog-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(0, 100)) {
        try {
          const file = path.join(inbox, name);
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('文件过大或不是普通文件');
          const raw = fs.readFileSync(file);
          const hash = crypto.createHash('sha256').update(raw).digest('hex');
          const pack = JSON.parse(raw.toString('utf8'));
          const photos = validatePackage(pack);
          if (name !== `lifelog-${pack.dateKey}.json`) throw new Error('文件名与日期不一致');
          const existing = store.entries[pack.dateKey];
          if (!ledger[hash] && existing?.inboxHash !== hash) {
            if (existing && (existing.note || existing.weather || existing.mood || existing.photos?.length)) {
              conflicts++;
              const conflictsDir = path.join(inbox, 'conflicts');
              fs.mkdirSync(conflictsDir, { recursive: true });
              if (fs.lstatSync(conflictsDir).isSymbolicLink() || fs.realpathSync(conflictsDir) !== path.join(inbox, 'conflicts')) throw new Error('冲突目录不能是链接');
              let conflicted = path.join(conflictsDir, `${path.basename(name, '.json')}-${hash}.json`);
              if (fs.existsSync(conflicted)) conflicted = path.join(conflictsDir, `${path.basename(name, '.json')}-${hash}-${crypto.randomUUID()}.json`);
              fs.renameSync(file, conflicted);
              continue;
            }
            const media = path.join(root(), 'lifelog-media');
            fs.mkdirSync(media, { recursive: true });
            const savedPhotos = photos.map((photo, i) => {
              const id = `inbox-${hash}-${i}`;
              const filename = id + photo.ext;
              fs.writeFileSync(path.join(media, filename), photo.bytes);
              return { id, path: filename, addedAt: Date.now() };
            });
            store.entries[pack.dateKey] = { weather: pack.weather || '', mood: pack.mood || '', note: pack.note || '', photos: savedPhotos, coverPhotoId: savedPhotos[pack.coverIndex || 0]?.id || null, updatedAt: Date.now(), inboxHash: hash };
            atomicJson(storeFile, store);
            imported++;
          }
          ledger[hash] = pack.dateKey;
          atomicJson(ledgerFile, ledger);
          fs.mkdirSync(done, { recursive: true });
          if (fs.lstatSync(done).isSymbolicLink() || fs.realpathSync(done) !== path.join(inbox, 'done')) throw new Error('归档目录不能是链接');
          let archived = path.join(done, `${path.basename(name, '.json')}-${hash}.json`);
          // Never replace a previously archived file.
          if (fs.existsSync(archived)) archived = path.join(done, `${path.basename(name, '.json')}-${hash}-${crypto.randomUUID()}.json`);
          fs.renameSync(file, archived);
        } catch { failed++; }
      }
      lastImport = `导入 ${imported} 篇${conflicts ? ` · ${conflicts} 篇日期冲突，原文件保留` : ''}${failed ? ` · ${failed} 个文件待重试` : ''}`;
    } catch { lastImport = '暂时无法读取收件箱或日记数据，下次启动重试'; }
    return status();
  }
  return { root, status, scan, migrate, configure(values) { save({ ...config, ...values }); return status(); } };
}

function validatePackage(p) {
  if (!p || p.schema !== 'luma-lifelog-inbox-v1' || !/^\d{4}-\d{2}-\d{2}$/.test(p.dateKey) || new Date(p.dateKey).toISOString().slice(0, 10) !== p.dateKey) throw new Error('日记格式错误');
  if (!['', 'sunny', 'cloudy', 'rainy', 'foggy', 'snowy', 'storm'].includes(p.weather || '') || !['', 'great', 'good', 'okay', 'calm', 'low', 'awful'].includes(p.mood || '')) throw new Error('天气或心情错误');
  if (typeof p.note !== 'string' || p.note.length > 100000 || !Array.isArray(p.photos) || p.photos.length > 9) throw new Error('日记内容过大或格式错误');
  if (p.photos.length && (!Number.isInteger(p.coverIndex) || p.coverIndex < 0 || p.coverIndex >= p.photos.length)) throw new Error('封面索引错误');
  return p.photos.map(photo => {
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[photo.mime];
    if (!ext || typeof photo.dataBase64 !== 'string') throw new Error('不支持的图片');
    const raw = photo.dataBase64.replace(/^data:image\/(?:jpeg|png|webp);base64,/, '');
    if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4) throw new Error('图片数据无效');
    const bytes = Buffer.from(raw, 'base64');
    const signature = ext === '.jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!signature || bytes.length > 8 * 1024 * 1024) throw new Error('图片格式无效或过大');
    return { ext, bytes };
  });
}
module.exports = { createLocalData, validatePackage, atomicJson };
