import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { AdapterError } from "../errors.js";
import type { DuomiClient } from "../duomi-client.js";
import { GROK_MODELS, IMAGE_MIME_TYPES, KLING_MODELS, VEO_MODELS, canonicalVideoModel, imageUrls, mapVideoTask, validateVideoReferenceCount, videoPayload } from "../media.js";
import type { ReferenceStorage } from "../storage.js";
import type { AdapterConfig, VideoJsonRequest } from "../types.js";
import { parseMultipart } from "../multipart.js";

export function videoRoutes(_config: AdapterConfig, client: DuomiClient, storage?: ReferenceStorage): FastifyPluginAsync {
    return async (app) => {
        app.post("/v1/videos", async (request) => {
            const payload = request.isMultipart() ? await multipartVideoRequest(request, storage) : jsonVideoRequest(request.body);
            const id = await client.createVideo(payload);
            return { id, status: "queued" };
        });

        app.get<{ Params: { id: string } }>("/v1/videos/:id", async (request) => mapVideoTask(request.params.id, await client.getVideoTask(request.params.id)));
    };
}

function jsonVideoRequest(value: unknown) {
    const body = record(value) as VideoJsonRequest;
    const model = validateModel(text(body.model));
    const prompt = text(body.prompt);
    if (!prompt) throw new AdapterError(400, "prompt is required", "invalid_request_error");
    const urls = imageUrls(body.image_urls, 7, false);
    validateVideoReferenceCount(model, urls.length);
    return videoPayload(model, prompt, text(body.size), text(body.seconds), text(body.resolution_name), urls, {
        multiShot: body.multi_shot,
        multiPrompt: body.multi_prompt,
    });
}

async function multipartVideoRequest(request: FastifyRequest, storage?: ReferenceStorage) {
    const parsed = await parseMultipart(request, { fileSize: 20 * 1024 * 1024, files: 7, fields: 12, parts: 20 });
    try {
        const { files, fields } = parsed;
        const model = validateModel(fields.model || "");
        const prompt = fields.prompt || "";
        if (!prompt) throw new AdapterError(400, "prompt is required", "invalid_request_error");
        const images = files.filter((file) => ["input_reference[]", "input_reference", "image", "image[]"].includes(file.fieldname));
        if (images.length !== files.length) throw new AdapterError(400, "Only image reference files are supported", "invalid_request_error");
        const invalidMime = images.find((file) => !IMAGE_MIME_TYPES.has(file.mimetype));
        if (invalidMime) throw new AdapterError(400, `Unsupported image type: ${invalidMime.mimetype}`, "invalid_request_error");
        if (GROK_MODELS.has(model) && images.some((file) => file.bytes > 10 * 1024 * 1024)) throw new AdapterError(413, "Grok reference images must not exceed 10 MB each", "invalid_request_error");
        validateVideoReferenceCount(model, images.length);
        if (images.length && !storage) throw new AdapterError(503, "Reference image storage is not configured", "configuration_error");
        const urls = storage ? await Promise.all(images.map((file) => storage.upload(file))) : [];
        return videoPayload(model, prompt, fields.size || "", fields.seconds || "", fields.resolution_name || "", urls);
    } finally {
        await parsed.cleanup();
    }
}

function validateModel(value: string) {
    const model = canonicalVideoModel(value);
    if (!VEO_MODELS.has(model) && !GROK_MODELS.has(model) && !KLING_MODELS.has(model)) throw new AdapterError(400, `Unsupported Duomi video model: ${model || "empty"}`, "invalid_request_error");
    return model;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return typeof value === "string" ? value.trim() : "";
}
