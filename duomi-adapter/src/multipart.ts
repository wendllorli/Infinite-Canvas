import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { AdapterError } from "./errors.js";
import type { UploadFile } from "./storage.js";

export type ParsedUploadFile = UploadFile & { fieldname: string; bytes: number };

export type ParsedMultipart = {
    fields: Record<string, string>;
    files: ParsedUploadFile[];
    cleanup: () => Promise<void>;
};

export async function parseMultipart(request: FastifyRequest, limits: { fileSize: number; files: number; fields?: number; parts?: number }): Promise<ParsedMultipart> {
    if (!request.isMultipart()) throw new AdapterError(400, "multipart/form-data is required", "invalid_request_error");
    const directory = await mkdtemp(join(tmpdir(), "duomi-adapter-"));
    const fields: Record<string, string> = {};
    const files: ParsedUploadFile[] = [];
    const cleanup = () => rm(directory, { recursive: true, force: true });
    try {
        for await (const part of request.parts({ limits })) {
            if (part.type === "field") {
                if (!(part.fieldname in fields)) fields[part.fieldname] = typeof part.value === "string" ? part.value.trim() : String(part.value ?? "").trim();
                continue;
            }
            const filepath = join(directory, `${randomUUID()}${safeExtension(part.filename)}`);
            await pipeline(part.file, createWriteStream(filepath));
            if (part.file.truncated) throw new AdapterError(413, `File exceeds ${Math.floor(limits.fileSize / 1024 / 1024)} MB limit`, "invalid_request_error");
            files.push({ fieldname: part.fieldname, filepath, filename: part.filename, mimetype: part.mimetype, bytes: (await stat(filepath)).size });
        }
        return { fields, files, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

function safeExtension(filename: string) {
    const value = extname(filename).toLowerCase();
    return /^\.[a-z0-9]{1,8}$/.test(value) ? value : "";
}
