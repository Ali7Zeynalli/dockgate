// A small tar reader / writer for Docker's archive API (getArchive / putArchive): reading and writing the files of a
// stopped container, where `docker exec` can not run. Regular files and folders only; long names (GNU "L") read.

/** One regular file as a tar archive (put into the folder given to putArchive). */
function makeTar(name, content, mode = 0o644) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (Buffer.byteLength(name) > 100) throw new Error('File name too long for the archive');
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write((mode & 0o7777).toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\x0000', 257);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]);
}

/** A tar archive → [{ name, type: 'file'|'dir'|'link'|'other', data, mode }] (names relative to the archive root). */
function parseTar(buf) {
  const out = []; let i = 0; let longName = null;
  const str = (b) => b.toString('utf8').replace(/\0[\s\S]*$/, '');
  while (i + 512 <= buf.length) {
    const h = buf.subarray(i, i + 512);
    if (h.every(x => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h.subarray(345, 500));
    let name = longName || (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    longName = null;
    const data = buf.subarray(i + 512, i + 512 + size);
    i += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(data); continue; }
    if (type === 'x' || type === 'g') continue; // pax headers
    out.push({ name: name.replace(/^\.\//, ''), type: type === '0' || type === '\0' ? 'file' : type === '5' ? 'dir' : type === '2' || type === '1' ? 'link' : 'other', data: Buffer.from(data), mode: parseInt(str(h.subarray(100, 108)).trim() || '0', 8) });
  }
  return out;
}

/** Collect a stream (getArchive) into one Buffer, up to max bytes. */
function collect(stream, max = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    stream.on('data', (d) => { n += d.length; if (n > max) { stream.destroy(); reject(new Error('Archive too large')); } else parts.push(d); });
    stream.on('end', () => resolve(Buffer.concat(parts))); stream.on('error', reject);
  });
}

module.exports = { makeTar, parseTar, collect };
