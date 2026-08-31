const fs = require('fs');

// multer's fileFilter only sees the client-controlled mimetype/extension
// before any bytes are read off the stream, so a renamed file (e.g. a script
// renamed to .png) passes fileFilter unchecked (S12, Roadmap v2 Phase G3,
// docs/SYSTEM_AUDIT_2026-07-16.md). This runs after the file is already saved
// to disk by multer's diskStorage and confirms its first bytes actually match
// a real magic number for the mimetype it claims — deleting the file and
// returning false if they don't.
const SIGNATURES = {
  'image/jpeg': [Buffer.from([0xFF, 0xD8, 0xFF])],
  'image/png': [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  'application/pdf': [Buffer.from('%PDF-', 'ascii')]
};

function verifyMagicBytes(file) {
  const signatures = SIGNATURES[file.mimetype];
  if (!signatures) return false;
  const header = Buffer.alloc(8);
  const fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, header, 0, 8, 0);
  fs.closeSync(fd);
  const matches = signatures.some((sig) => header.slice(0, sig.length).equals(sig));
  if (!matches) fs.unlink(file.path, () => {});
  return matches;
}

module.exports = verifyMagicBytes;
