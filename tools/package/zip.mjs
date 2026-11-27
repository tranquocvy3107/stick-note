// A small ZIP reader and writer with no dependencies.
//
// Why not Compress-Archive or tar? Their behaviour differs between Windows PowerShell 5, PowerShell 7
// and the "tar" that happens to come first on PATH (Git's GNU tar cannot read zip files at all).
// Writing the few bytes of the format ourselves gives forward-slash names, fixed timestamps and the
// same result everywhere.
//
// Not supported on purpose: ZIP64 (nothing here is near 4 GiB), encryption and multi-disk archives.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { fail } from './lib.mjs';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_NAMES = 0x0800; // general purpose flag, bit 11
const STORED = 0;
const DEFLATED = 8;

// zlib.crc32 exists from Node 22.2; the table version keeps older Node versions working.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf);
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP stores local time without a zone; using the UTC fields of `epoch` keeps the output identical everywhere. */
function dosDateTime(epoch) {
  const d = new Date(Math.max(epoch, 315532800) * 1000); // the format cannot go below 1980-01-01
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Write a zip file.
 * @param {string} outFile
 * @param {{name: string, file?: string, data?: Buffer}[]} entries  `name` uses forward slashes.
 * @param {{epoch: number}} options  modification time (seconds since 1970) given to every entry.
 */
export function writeZip(outFile, entries, { epoch }) {
  if (entries.length >= 0xffff) fail('Too many files for a plain zip archive');
  const stamp = dosDateTime(epoch);
  const fd = fs.openSync(outFile, 'w');
  const central = [];
  let offset = 0;
  const put = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
    if (offset >= 0xffffffff) fail('The zip archive would be larger than 4 GiB');
  };

  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const data = entry.data ?? fs.readFileSync(entry.file);
      const method = data.length > 0 ? DEFLATED : STORED;
      const packed = method === DEFLATED ? zlib.deflateRawSync(data, { level: 9 }) : data;
      const crc = crc32(data);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIGNATURE, 0);
      local.writeUInt16LE(20, 4); // version needed to extract: 2.0
      local.writeUInt16LE(UTF8_NAMES, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(stamp.time, 10);
      local.writeUInt16LE(stamp.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28); // no extra field

      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
      header.writeUInt16LE(20, 4); // made by: MS-DOS / spec 2.0
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(UTF8_NAMES, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(stamp.time, 12);
      header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(packed.length, 20);
      header.writeUInt32LE(data.length, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([header, name]));

      put(local);
      put(name);
      put(packed);
    }

    const directoryStart = offset;
    for (const record of central) put(record);
    const directorySize = offset - directoryStart;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIGNATURE, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryStart, 16);
    put(end);
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse the central directory of a zip file. Returns the file bytes and a Map of name -> entry. */
export function readZip(file) {
  const buf = fs.readFileSync(file);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END_SIGNATURE) { end = i; break; }
  }
  if (end < 0) fail(`${file} is not a zip file (no end-of-archive record)`);

  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) fail(`${file} is damaged (bad central directory)`);
    const entry = {
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      packedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    };
    const nameLength = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    if (entry.packedSize === 0xffffffff || entry.size === 0xffffffff || entry.localOffset === 0xffffffff) {
      fail(`${file} uses ZIP64, which this reader does not support`);
    }
    entries.set(name, entry);
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { buf, entries };
}

/** The uncompressed bytes of one entry, checked against its CRC-32. */
export function readEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) fail(`The zip file has no "${name}"`);
  const { buf } = zip;
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== LOCAL_SIGNATURE) fail(`The zip entry "${name}" is damaged`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const packed = buf.subarray(start, start + entry.packedSize);
  let data;
  if (entry.method === STORED) data = packed;
  else if (entry.method === DEFLATED) data = zlib.inflateRawSync(packed);
  else fail(`The zip entry "${name}" uses compression method ${entry.method}, which is not supported`);
  if (data.length !== entry.size || crc32(data) !== entry.crc) fail(`The zip entry "${name}" failed its integrity check`);
  return data;
}
