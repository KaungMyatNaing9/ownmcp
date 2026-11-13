import { inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

/** Read a non-ZIP64 archive. Playwright traces recorded without screenshots fit. */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  const lower = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= lower; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (ZIP64 traces are not supported)");

  const count = buffer.readUInt16LE(eocd + 8);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL) {
      throw new Error("Broken ZIP central directory");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`Broken local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`Unsupported ZIP method ${method} for ${name}`);
    if (!name.endsWith("/")) files.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
