import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { AdapterError } from "./config.js";
import type { StorageConfig } from "./types.js";

export type UploadFile = {
    filepath: string;
    filename: string;
    mimetype: string;
};

export interface ReferenceStorage {
    upload(file: UploadFile): Promise<string>;
}

export class S3ReferenceStorage implements ReferenceStorage {
    private readonly client: S3Client;

    constructor(private readonly config: StorageConfig) {
        const missing = [
            ["STORAGE_ENDPOINT", config.endpoint],
            ["STORAGE_BUCKET", config.bucket],
            ["STORAGE_ACCESS_KEY", config.accessKey],
            ["STORAGE_SECRET_KEY", config.secretKey],
            ["STORAGE_PUBLIC_BASE_URL", config.publicBaseUrl],
        ].filter(([, value]) => !value);
        if (missing.length) throw new AdapterError(503, `Storage is not configured: ${missing.map(([name]) => name).join(", ")}`, "configuration_error");
        this.client = new S3Client({
            endpoint: config.endpoint,
            region: config.region,
            credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
            forcePathStyle: config.forcePathStyle,
        });
    }

    async upload(file: UploadFile) {
        const key = `duomi-references/${randomUUID()}${extension(file.mimetype)}`;
        try {
            await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: createReadStream(file.filepath), ContentType: file.mimetype }));
        } catch (error) {
            throw new AdapterError(502, error instanceof Error ? `Reference image upload failed: ${error.message}` : "Reference image upload failed", "storage_error");
        }
        return `${this.config.publicBaseUrl}/${key
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/")}`;
    }
}

function extension(mimetype: string) {
    if (mimetype === "image/jpeg") return ".jpg";
    if (mimetype === "image/webp") return ".webp";
    if (mimetype === "image/gif") return ".gif";
    return ".png";
}
