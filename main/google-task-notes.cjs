const LEGACY_PREFIX = '[Luma Todo]\n';
const START = '[Luma Todo Metadata v4]';
const END = '[/Luma Todo Metadata]';

function parseGoogleTaskNotes(notes) {
  const value = typeof notes === 'string' ? notes : '';

  if (value.startsWith(LEGACY_PREFIX)) {
    const raw = value.slice(LEGACY_PREFIX.length);
    try {
      return { metadata: JSON.parse(raw), userNotes: '', format: 'legacy-json' };
    } catch {
      const legacyProject = value.match(/(?:^|\n)分类：([^\n]+)/)?.[1]?.trim();
      if (legacyProject) {
        return {
          metadata: { version: 1, projectId: legacyProject },
          userNotes: '',
          format: 'legacy-text',
        };
      }
    }
  }

  const start = value.lastIndexOf(START);
  const end = start >= 0 ? value.indexOf(END, start + START.length) : -1;
  if (start < 0 || end < 0) return { metadata: null, userNotes: value, format: 'user-only' };

  const raw = value.slice(start + START.length, end).trim();
  let metadata = null;
  try { metadata = JSON.parse(raw); } catch {}
  const before = value.slice(0, start).replace(/\s+$/, '');
  const after = value.slice(end + END.length).replace(/^\s+/, '');
  return {
    metadata,
    userNotes: [before, after].filter(Boolean).join('\n\n'),
    format: metadata ? 'v4' : 'invalid-v4',
  };
}

function buildGoogleTaskNotes(existingNotes, metadata) {
  const { userNotes } = parseGoogleTaskNotes(existingNotes);
  const prefix = userNotes ? userNotes.replace(/\s+$/, '') + '\n\n' : '';
  return prefix + START + '\n' + JSON.stringify(metadata) + '\n' + END;
}

module.exports = {
  LEGACY_PREFIX,
  START,
  END,
  parseGoogleTaskNotes,
  buildGoogleTaskNotes,
};
