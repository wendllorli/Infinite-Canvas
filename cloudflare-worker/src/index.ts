import { DuomiClient } from "../../duomi-adapter/src/duomi-client.js";
import { AdapterError } from "../../duomi-adapter/src/errors.js";
import { GROK_MODELS, IMAGE_MIME_TYPES, QUALITY_VALUES, VEO_MODELS, canonicalVideoModel, imageUrls, mapVideoTask, validateVideoReferenceCount, videoPayload } from "../../duomi-adapter/src/media.js";
import { fetchDuomiResultImage } from "../../duomi-adapter/src/media-proxy.js";
import type { AdapterConfig, AdapterErrorBody, DuomiImageRequest } from "../../duomi-adapter/src/types.js";
import { siteAuthResponse } from "./site-auth.js";

export interface Env {
    ASSETS?: Fetcher;
    REFERENCES: R2Bucket;
    DUOMI_API_BASE?: string;
    DUOMI_API_KEY?: string;
    DUOMI_AUTH_MODE?: string;
    DUOMI_POLL_INTERVAL_MS?: string;
    DUOMI_TIMEOUT_MS?: string;
    DUOMI_IMAGE_MODEL?: string;
    DUOMI_VIDEO_MODELS?: string;
    STORAGE_PUBLIC_BASE_URL?: string;
    SITE_PASSWORD?: string;
}

const API_PREFIX = "/api/duomi";
const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_TIMEOUT_MS = 600000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
type ReferenceImage = Pick<File, "type" | "size" | "arrayBuffer">;

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            return await handleRequest(request, env);
        } catch (error) {
            return errorResponse(error);
        }
    },
} satisfies ExportedHandler<Env>;

export async function handleRequest(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
    const authResponse = await siteAuthResponse(request, env.SITE_PASSWORD);
    if (authResponse) return authResponse;

    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) {
        return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: { message: "Not found", type: "not_found" } }, 404);
    }
    const path = url.pathname.slice(API_PREFIX.length) || "/";
    const config = workerConfig(env);
    const client = new DuomiClient(config, { fetch: fetchImpl });

    if (request.method === "GET" && path === "/health") return json({ ok: true, service: "duomi-adapter" });
    if (request.method === "GET" && path === "/v1/models") {
        return json({ object: "list", data: [config.imageModel, ...config.videoModels].map((id) => ({ id, object: "model", owned_by: "duomi" })) });
    }
    if (request.method === "GET" && path === "/v1/media") return mediaResponse(url.searchParams.get("url"), fetchImpl);
    if (request.method === "POST" && path === "/v1/uploads") return uploadResponse(request, env);
    if (request.method === "POST" && path === "/v1/images/generations") return json(await client.generateImages(generationRequest(config, await jsonBody(request))));
    if (request.method === "POST" && path === "/v1/images/edits") return json(await client.generateImages(await editRequest(request, config, env)));
    if (request.method === "POST" && path === "/v1/videos") {
        const id = await client.createVideo(await videoRequest(request, env));
        return json({ id, status: "queued" });
    }
    const videoMatch = request.method === "GET" ? path.match(/^\/v1\/videos\/([^/]+)$/) : null;
    if (videoMatch) {
        const id = decodeURIComponent(videoMatch[1]!);
        return json(mapVideoTask(id, await client.getVideoTask(id)));
    }
    return json({ error: { message: "Not found", type: "not_found" } }, 404);
}

export function defaultImageUpstreamRequestBudget(timeoutMs = DEFAULT_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    return 1 + Math.ceil(timeoutMs / pollIntervalMs);
}

function workerConfig(env: Env): AdapterConfig {
    const authMode = (env.DUOMI_AUTH_MODE || "raw").trim().toLowerCase();
    if (authMode !== "raw" && authMode !== "bearer") throw new AdapterError(503, "DUOMI_AUTH_MODE must be raw or bearer", "configuration_error");
    return {
        port: 8787,
        apiBase: (env.DUOMI_API_BASE || "https://duomiapi.com").replace(/\/+$/, ""),
        apiKey: env.DUOMI_API_KEY?.trim() || "",
        authMode,
        pollIntervalMs: positiveInteger(env.DUOMI_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, "DUOMI_POLL_INTERVAL_MS"),
        timeoutMs: positiveInteger(env.DUOMI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "DUOMI_TIMEOUT_MS"),
        imageModel: env.DUOMI_IMAGE_MODEL?.trim() || "gpt-image-2",
        videoModels: csv(env.DUOMI_VIDEO_MODELS, ["veo3.1-fast", "veo3.1-pro", "grok-video", "grok-video-1.5"]),
    };
}

async function mediaResponse(value: unknown, fetchImpl: typeof fetch) {
    const upstream = await fetchDuomiResultImage(value, fetchImpl);
    const headers = new Headers({
        "Content-Type": upstream.headers.get("content-type") || "image/png",
        "Cache-Control": "private, max-age=300",
    });
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);
    return new Response(upstream.body, { status: 200, headers });
}

function generationRequest(config: AdapterConfig, body: Record<string, unknown>): DuomiImageRequest {
    const prompt = text(body.prompt);
    validatePrompt(prompt);
    const quality = text(body.quality);
    validateQuality(quality);
    return { model: text(body.model) || config.imageModel, prompt, ...(text(body.size) ? { size: text(body.size) } : {}), ...(quality ? { quality } : {}) };
}

async function editRequest(request: Request, config: AdapterConfig, env: Env): Promise<DuomiImageRequest> {
    if (!isMultipart(request)) {
        const body = await jsonBody(request);
        if (body.mask) throw maskError();
        const prompt = text(body.prompt);
        validatePrompt(prompt);
        const quality = text(body.quality);
        validateQuality(quality);
        return { model: text(body.model) || config.imageModel, prompt, ...(text(body.size) ? { size: text(body.size) } : {}), ...(quality ? { quality } : {}), image: imageUrls(body.image, 9) };
    }
    const form = await request.formData();
    if (form.has("mask")) throw maskError();
    const files = filesFor(form, ["image", "image[]"]);
    if (!files.length) throw new AdapterError(400, "At least one reference image is required", "invalid_request_error");
    if (files.length > 9) throw new AdapterError(400, "A maximum of 9 reference images is supported", "invalid_request_error");
    const prompt = field(form, "prompt");
    validatePrompt(prompt);
    const quality = field(form, "quality");
    validateQuality(quality);
    const urls = await Promise.all(files.map((file) => uploadFile(file, env)));
    return { model: field(form, "model") || config.imageModel, prompt, ...(field(form, "size") ? { size: field(form, "size") } : {}), ...(quality ? { quality } : {}), image: urls };
}

async function videoRequest(request: Request, env: Env) {
    if (!isMultipart(request)) {
        const body = await jsonBody(request);
        const model = videoModel(text(body.model));
        const prompt = text(body.prompt);
        if (!prompt) throw new AdapterError(400, "prompt is required", "invalid_request_error");
        const urls = imageUrls(body.image_urls, 7, false);
        validateVideoReferenceCount(model, urls.length);
        return videoPayload(model, prompt, text(body.size), text(body.seconds), text(body.resolution_name), urls);
    }
    const form = await request.formData();
    const model = videoModel(field(form, "model"));
    const prompt = field(form, "prompt");
    if (!prompt) throw new AdapterError(400, "prompt is required", "invalid_request_error");
    const files = filesFor(form, ["input_reference[]", "input_reference", "image", "image[]"]);
    validateVideoReferenceCount(model, files.length);
    validateFiles(files);
    if (GROK_MODELS.has(model) && files.some((file) => file.size > 10 * 1024 * 1024)) throw new AdapterError(413, "Grok reference images must not exceed 10 MB each", "invalid_request_error");
    const urls = await Promise.all(files.map((file) => uploadFile(file, env)));
    return videoPayload(model, prompt, field(form, "size"), field(form, "seconds"), field(form, "resolution_name"), urls);
}

async function uploadResponse(request: Request, env: Env) {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
    if (IMAGE_MIME_TYPES.has(contentType)) {
        const declaredSize = Number(request.headers.get("content-length"));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) throw new AdapterError(413, "File exceeds 20 MB limit", "invalid_request_error");
        const bytes = await request.arrayBuffer();
        const image: ReferenceImage = { type: contentType, size: bytes.byteLength, arrayBuffer: async () => bytes };
        return json({ url: await uploadFile(image, env) });
    }
    if (!isMultipart(request)) throw new AdapterError(400, "An image body or multipart/form-data is required", "invalid_request_error");
    const files = filesFor(await request.formData(), ["image", "file"]);
    if (files.length !== 1) throw new AdapterError(400, "Exactly one image file is required", "invalid_request_error");
    return json({ url: await uploadFile(files[0]!, env) });
}

async function uploadFile(file: ReferenceImage, env: Env) {
    validateFiles([file]);
    const baseUrl = env.STORAGE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new AdapterError(503, "STORAGE_PUBLIC_BASE_URL is not configured", "configuration_error");
    const key = `duomi-references/${crypto.randomUUID()}${extension(file.type)}`;
    try {
        // ArrayBuffer is accepted consistently by both Miniflare and production R2.
        // The upload is capped at 20 MB, so buffering it stays comfortably inside
        // the Workers memory limit and avoids stream compatibility differences.
        await env.REFERENCES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    } catch (error) {
        throw new AdapterError(502, error instanceof Error ? `Reference image upload failed: ${error.message}` : "Reference image upload failed", "storage_error");
    }
    return `${baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function validateFiles(files: ReferenceImage[]) {
    for (const file of files) {
        if (!IMAGE_MIME_TYPES.has(file.type)) throw new AdapterError(400, `Unsupported image type: ${file.type}`, "invalid_request_error");
        if (file.size > MAX_IMAGE_BYTES) throw new AdapterError(413, "File exceeds 20 MB limit", "invalid_request_error");
    }
}

function filesFor(form: FormData, names: string[]) {
    return names.flatMap((name) => form.getAll(name)).filter(isUploadedFile);
}

function isUploadedFile(value: FormDataEntryValue): value is File {
    // Do not rely on `instanceof File`: production Workers and local test
    // runtimes can expose FormData files from different JavaScript realms.
    return typeof value !== "string"
        && typeof value.arrayBuffer === "function"
        && typeof value.type === "string"
        && typeof value.size === "number";
}

function field(form: FormData, name: string) {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
}

function videoModel(value: string) {
    const model = canonicalVideoModel(value);
    if (!VEO_MODELS.has(model) && !GROK_MODELS.has(model)) throw new AdapterError(400, `Unsupported Duomi video model: ${model || "empty"}`, "invalid_request_error");
    return model;
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

async function jsonBody(request: Request) {
    try {
        const value = await request.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        return value as Record<string, unknown>;
    } catch {
        throw new AdapterError(400, "Request body must be valid JSON", "invalid_request_error");
    }
}

function isMultipart(request: Request) {
    return request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data") || false;
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
    if (!value?.trim()) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new AdapterError(503, `${name} must be a positive integer`, "configuration_error");
    return parsed;
}

function csv(value: string | undefined, fallback: string[]) {
    const values = value?.split(",").map((item) => item.trim()).filter(Boolean);
    return values?.length ? Array.from(new Set(values)) : fallback;
}

function extension(mimetype: string) {
    if (mimetype === "image/jpeg") return ".jpg";
    if (mimetype === "image/webp") return ".webp";
    if (mimetype === "image/gif") return ".gif";
    return ".png";
}

function text(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return typeof value === "string" ? value.trim() : "";
}

function errorResponse(error: unknown) {
    if (error instanceof AdapterError) {
        const body: AdapterErrorBody = { error: { message: error.message, type: error.type, ...(error.upstreamStatus !== undefined ? { status: error.upstreamStatus } : {}) } };
        return json(body, error.statusCode);
    }
    console.error("Unhandled Worker request error", error);
    return json({ error: { message: "Internal server error", type: "internal_error" } }, 500);
}

function json(value: unknown, status = 200) {
    return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
