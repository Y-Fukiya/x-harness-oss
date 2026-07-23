export interface MediaBodyWriteInput {
  bucket: R2Bucket;
  r2Key: string;
  body: ReadableStream<Uint8Array>;
  byteSize: number;
  checksum: ArrayBuffer;
  contentType: string;
  assetId: string;
  sha256: string;
}

export type MediaBodyWriter = (input: MediaBodyWriteInput) => Promise<R2Object | null>;

export const MEDIA_SIZE_LIMITS = {
  'image/jpeg': 5 * 1024 * 1024,
  'image/png': 5 * 1024 * 1024,
  'image/webp': 5 * 1024 * 1024,
  'image/gif': 15 * 1024 * 1024,
  // Leaves headroom below the deployed Workers request-body ceiling.
  'video/mp4': 95_000_000,
} as const;

export const writeMediaBodyToR2: MediaBodyWriter = async (input) => {
  const fixedLength = new FixedLengthStream(input.byteSize);
  const [stored] = await Promise.all([
    input.bucket.put(input.r2Key, fixedLength.readable, {
      onlyIf: { etagDoesNotMatch: '*' },
      sha256: input.checksum,
      httpMetadata: { contentType: input.contentType },
      customMetadata: { assetId: input.assetId, sha256: input.sha256 },
    }),
    input.body.pipeTo(fixedLength.writable),
  ]);
  return stored;
};
