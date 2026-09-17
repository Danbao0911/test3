export const MAX_MULTIPART_REQUEST_BYTES = 2 * 1024 * 1024 + 64 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("请求体不能超过 2 MiB 加 multipart 开销上限");
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidMultipartError extends Error {
  constructor() {
    super("multipart/form-data 请求格式无效");
    this.name = "InvalidMultipartError";
  }
}

export async function readBoundedFormData(request: Request) {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0) throw new InvalidMultipartError();
    if (length > MAX_MULTIPART_REQUEST_BYTES) throw new RequestBodyTooLargeError();
  }
  if (!request.body) throw new InvalidMultipartError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_MULTIPART_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return await new Request(request.url, { method: request.method, headers: request.headers, body }).formData();
  } catch {
    throw new InvalidMultipartError();
  }
}
