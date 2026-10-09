const encoder = new TextEncoder();
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function header(size) { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; }
// ZIP STORE format: original images are preserved byte for byte, without re-encoding.
export async function makeZip(files, options = {}) {
  const parts = [], central = []; let offset = 0;
  const now = options.date || new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : new Uint8Array(await file.data.arrayBuffer());
    const crc = crc32(data);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true); local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(10, time, true); local.view.setUint16(12, date, true); local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true); local.view.setUint32(22, data.length, true); local.view.setUint16(26, name.length, true);
    parts.push(local.bytes, name, data);
    const entry = header(46);
    entry.view.setUint32(0, 0x02014b50, true); entry.view.setUint16(4, 20, true); entry.view.setUint16(6, 20, true);
    entry.view.setUint16(8, 0x0800, true); entry.view.setUint16(12, time, true); entry.view.setUint16(14, date, true);
    entry.view.setUint32(16, crc, true); entry.view.setUint32(20, data.length, true); entry.view.setUint32(24, data.length, true);
    entry.view.setUint16(28, name.length, true); entry.view.setUint32(42, offset, true); central.push(entry.bytes, name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = header(22); end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true); end.view.setUint32(12, centralSize, true); end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.bytes], { type: 'application/zip' });
}
