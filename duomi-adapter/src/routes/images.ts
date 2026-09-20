import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { AdapterError } from "../errors.js";
import { IMAGE_MIME_TYPES, QUALITY_VALUES, imageUrls } from "../media.js";
import type { DuomiClient } from "../duomi-client.js";
import type { AdapterConfig, DuomiImageRequest, ImageEditJsonRequest, ImageGenerationRequest } from "../types.js";
import type { ReferenceStorage } from "../storage.js";
import { parseMultipart } from "../multipart.js";

export function imageRoutes(config: AdapterConfig, client: DuomiClient, storage?: ReferenceStorage): FastifyPluginAsync {
    return async (app) => {
        app.post<{ Body: ImageGenerationRequest }>("/v1/images/generations", async (request) => client.generateImages(imageRequest(config, request.body || {})));

        app.post("/v1/images/edits", async (request) => {
            if (!request.isMultipart()) return client.generateImages(imageEditJsonRequest(config, request.body));
            return imageEditMultipart(request, config, client, storage);
        });
    };
}

function imageRequest(config: AdapterConfig, body: ImageGenerationRequest): DuomiImageRequest {
    const prompt = text(body.prompt);
    validatePrompt(prompt);
    const quality = text(body.quality);
    validateQuality(quality);
    return {
        model: text(body.model) || config.imageModel,
        prompt,
        ...(text(body.size) ? { size: text(body.size) } : {}),
        ...(quality ? { quality } : {}),
    };
}

function imageEditJsonRequest(config: AdapterConfig, value: unknown): DuomiImageRequest {
    const body = record(value) as ImageEditJsonRequest;
    if (body.mask) throw maskError();
    const prompt = text(body.prompt);
    validatePrompt(prompt);
    const quality = text(body.quality);
    validateQuality(quality);
    return {
        model: text(body.model) || config.imageModel,
        prompt,
        ...(text(body.size) ? { size: text(body.size) } : {}),
        ...(quality ? { quality } : {}),
        image: imageUrls(body.image, 9),
    };
}

async function imageEditMultipart(request: FastifyRequest, config: AdapterConfig, client: DuomiClient, storage?: ReferenceStorage) {
    const parsed = await parseMultipart(request, { fileSize: 20 * 1024 * 1024, files: 10, fields: 12, parts: 22 });
    try {
        const { files, fields } = parsed;
        if (files.some((file) => file.fieldname === "mask") || fields.mask) throw maskError();
        const images = files.filter((file) => file.fieldname === "image" || file.fieldname === "image[]");
        if (!images.length) throw new AdapterError(400, "At least one reference image is required", "invalid_request_error");
        if (images.length > 9) throw new AdapterError(400, "A maximum of 9 reference images is supported", "invalid_request_error");
        const unexpected = files.find((file) => !["image", "image[]"].includes(file.fieldname));
        if (unexpected) throw new AdapterError(400, `Unsupported file field: ${unexpected.fieldname}`, "invalid_request_error");
        const invalidMime = images.find((file) => !IMAGE_MIME_TYPES.has(file.mimetype));
        if (invalidMime) throw new AdapterError(400, `Unsupported image type: ${invalidMime.mimetype}`, "invalid_request_error");
        if (!storage) throw new AdapterError(503, "Reference image storage is not configured", "configuration_error");
        const prompt = fields.prompt || "";
        validatePrompt(prompt);
        const quality = fields.quality || "";
        validateQuality(quality);
        const urls = await Promise.all(images.map((file) => storage.upload(file)));
        return await client.generateImages({
            model: fields.model || config.imageModel,
            prompt,
            ...(fields.size ? { size: fields.size } : {}),
            ...(quality ? { quality } : {}),
            image: urls,
        });
    } finally {
        await parsed.cleanup();
    }
}

function validatePrompt(prompt: string) {
    if (!prompt) throw new AdapterError(400, "prompt is required", "invalid_request_error");
    if (prompt.length > 5000) throw new AdapterError(400, "prompt must not exceed 5000 characters", "invalid_request_error");
}

function validateQuality(quality: string) {
    if (quality && !QUALITY_VALUES.has(quality)) throw new AdapterError(400, "quality must be low, medium, or high", "invalid_request_error");
}

function maskError() {
    return new AdapterError(400, "Duomi API does not currently support mask-based inpainting", "unsupported_feature");
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
