import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { Config } from "../../config.js";

export function createS3Client(config: Config): S3Client {
  return new S3Client({
    region: config.AMAZON_CONNECT_AWS_REGION,
    credentials: config.amazonConnectAwsCredentials, // undefined -> SDK's default credential chain
  });
}

async function streamToString(body: unknown): Promise<string> {
  // AWS SDK v3 returns a Node.js Readable in Node runtimes.
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

export async function fetchJsonObject<T>(s3: S3Client, bucket: string, key: string): Promise<T> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await streamToString(result.Body);
  return JSON.parse(text) as T;
}
