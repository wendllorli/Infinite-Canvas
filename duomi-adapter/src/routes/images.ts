import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { AdapterError } from "../errors.js";
import { IMAGE_MIME_TYPES, QUALITY_VALUES, imageUrls } from "../media.js";
import { isNanoBananaModel } from "../nano-banana.js";
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
    const model = text(body.model) || config.imageModel;
    const quality = text(body.quality);
    validateQuality(quality, model);
    return {
        model,
        prompt,
        ...(text(body.size) ? { size: text(body.size) } : {}),
        ...(quality ? { quality } : {}),
        ...(isNanoBananaModel(model) ? { n: imageCount(body.n) } : {}),
    };
}

function imageEditJsonRequest(config: AdapterConfig, value: unknown): DuomiImageRequest {
    const body = record(value) as ImageEditJsonRequest;
    if (body.mask) throw maskError();
    const prompt = text(body.prompt);
    validatePrompt(prompt);
    const model = text(body.model) || config.imageModel;
    const quality = text(body.quality);
    validateQuality(quality, model);
    return {
        model,
        prompt,
        ...(text(body.size) ? { size: text(body.size) } : {}),
        ...(quality ? { quality } : {}),
        ...(isNanoBananaModel(model) ? { n: imageCount(body.n) } : {}),
        image: imageUrls(body.image, referenceLimit(text(body.model) || config.imageModel)),
    };
}

async function imageEditMultipart(request: FastifyRequest, config: AdapterConfig, client: DuomiClient, storage?: ReferenceStorage) {
    const parsed = await parseMultipart(request, { fileSize: 20 * 1024 * 1024, files: 10, fields: 12, parts: 22 });
    try {
        const { files, fields } = parsed;
        if (files.some((file) => file.fieldname === "mask") || fields.mask) throw maskError();
        const images = files.filter((file) => file.fieldname === "image" || file.fieldname === "image[]");
        if (!images.length) throw new AdapterError(400, "At least one reference image is required", "invalid_request_error");
        const model = fields.model || config.imageModel;
        if (images.length > referenceLimit(model)) throw new AdapterError(400, `A maximum of ${referenceLimit(model)} reference images is supported`, "invalid_request_error");
        const unexpected = files.find((file) => !["image", "image[]"].includes(file.fieldname));
        if (unexpected) throw new AdapterError(400, `Unsupported file field: ${unexpected.fieldname}`, "invalid_request_error");
        const invalidMime = images.find((file) => !IMAGE_MIME_TYPES.has(file.mimetype));
        if (invalidMime) throw new AdapterError(400, `Unsupported image type: ${invalidMime.mimetype}`, "invalid_request_error");
        if (!storage) throw new AdapterError(503, "Reference image storage is not configured", "configuration_error");
        const prompt = fields.prompt || "";
        validatePrompt(prompt);
        const quality = fields.quality || "";
        validateQuality(quality, model);
        const urls = await Promise.all(images.map((file) => storage.upload(file)));
        return await client.generateImages({
            model,
            prompt,
            ...(fields.size ? { size: fields.size } : {}),
            ...(quality ? { quality } : {}),
            ...(isNanoBananaModel(model) ? { n: imageCount(fields.n) } : {}),
            image: urls,
        });
    } finally {
        await parsed.cleanup();
    }
}

function referenceLimit(model: string) {
    return isNanoBananaModel(model) ? 10 : 9;
}

function validatePrompt(prompt: string) {
    if (!prompt) throw new AdapterError(400, "prompt is required", "invalid_request_error");
    if (prompt.length > 5000) throw new AdapterError(400, "prompt must not exceed 5000 characters", "invalid_request_error");
}

function validateQuality(quality: string, model: string) {
    if (isNanoBananaModel(model)) return;
    if (quality && !QUALITY_VALUES.has(quality)) throw new AdapterError(400, "quality must be low, medium, or high", "invalid_request_error");
}

function imageCount(value: unknown) {
    if (value === undefined || value === "") return 1;
    const count = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(count) || count < 1 || count > 15) throw new AdapterError(400, "n must be an integer between 1 and 15", "invalid_request_error");
    return count;
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
