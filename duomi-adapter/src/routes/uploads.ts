import type { FastifyPluginAsync } from "fastify";

import { AdapterError } from "../errors.js";
import { IMAGE_MIME_TYPES } from "../media.js";
import { parseMultipart } from "../multipart.js";
import type { ReferenceStorage } from "../storage.js";

export function uploadRoutes(storage?: ReferenceStorage): FastifyPluginAsync {
    return async (app) => {
        app.post("/v1/uploads", async (request) => {
            if (!storage) throw new AdapterError(503, "Reference image storage is not configured", "configuration_error");
            const parsed = await parseMultipart(request, { fileSize: 20 * 1024 * 1024, files: 1, fields: 0, parts: 1 });
            try {
                if (parsed.files.length !== 1 || !["image", "file"].includes(parsed.files[0]!.fieldname)) {
                    throw new AdapterError(400, "Exactly one image file is required", "invalid_request_error");
                }
                const file = parsed.files[0]!;
                if (!IMAGE_MIME_TYPES.has(file.mimetype)) throw new AdapterError(400, `Unsupported image type: ${file.mimetype}`, "invalid_request_error");
                return { url: await storage.upload(file) };
            } finally {
                await parsed.cleanup();
            }
        });
    };
}
