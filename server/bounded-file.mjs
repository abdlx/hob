/** Read at most the observed size plus one byte, even if a file grows during I/O. */
export async function readObservedFile(handle, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > 25 * 1024 * 1024) throw new Error('File size exceeds the bounded reader.');
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}
