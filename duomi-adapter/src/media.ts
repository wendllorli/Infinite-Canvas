import { AdapterError } from "./errors.js";
import type { DuomiTask, DuomiVideoRequest } from "./types.js";

export const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const QUALITY_VALUES = new Set(["low", "medium", "high"]);
export const VEO_MODELS = new Set(["veo3.1-fast", "veo3.1-pro"]);
export const GROK_MODELS = new Set(["grok-video", "grok-video-1.5"]);

export function imageUrls(value: unknown, maximum: number, required = true) {
    const values = Array.isArray(value) ? value : [];
    if (required && !values.length) throw new AdapterError(400, "At least one reference image is required", "invalid_request_error");
    if (values.length > maximum) throw new AdapterError(400, `A maximum of ${maximum} reference images is supported`, "invalid_request_error");
    return values.map((item) => publicUrl(item));
}

export function publicUrl(value: unknown) {
    if (typeof value !== "string" || !value.trim()) throw new AdapterError(400, "Reference image URL is invalid", "invalid_request_error");
    try {
        const url = new URL(value.trim());
        const hostname = url.hostname.toLowerCase();
        if (!["http:", "https:"].includes(url.protocol) || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") throw new Error();
        return url.toString();
    } catch {
        throw new AdapterError(400, "Reference images must use publicly accessible HTTP URLs", "invalid_request_error");
    }
}

export function canonicalVideoModel(value: string) {
    return value.replace(/^veo_3\.1-/, "veo3.1-");
}

export function videoPayload(model: string, prompt: string, size: string, seconds: string, resolution: string, urls: string[]): DuomiVideoRequest {
    const aspectRatio = sizeToRatio(size);
    if (VEO_MODELS.has(model)) {
        const generationType = urls.length === 0 ? "TEXT" : urls.length <= 2 ? "FIRST&LAST" : "REFERENCE";
        if (generationType === "REFERENCE" && aspectRatio === "9:16") throw new AdapterError(400, "VEO REFERENCE mode does not support 9:16", "invalid_request_error");
        const quality = ["720p", "1080p", "4k"].includes(resolution) ? resolution : "720p";
        return { model, prompt, aspect_ratio: aspectRatio === "9:16" ? "9:16" : "16:9", duration: 8, quality, generation_type: generationType, ...(urls.length ? { image_urls: urls } : {}) };
    }
    const duration = Math.floor(Number(seconds) || 6);
    const allowed = model === "grok-video-1.5" ? [6, 10, 15] : [6, 10, 15, 20, 25, 30];
    if (!allowed.includes(duration)) throw new AdapterError(400, `${model} duration must be one of: ${allowed.join(", ")}`, "invalid_request_error");
    return { model, prompt, aspect_ratio: grokRatio(aspectRatio), duration, quality: "720p", ...(urls.length ? { image_urls: urls } : {}) };
}

export function validateVideoReferenceCount(model: string, count: number) {
    if (VEO_MODELS.has(model) && count > 3) throw new AdapterError(400, "VEO supports at most 3 reference images", "invalid_request_error");
    if (model === "grok-video-1.5" && count > 1) throw new AdapterError(400, "grok-video-1.5 supports at most 1 reference image", "invalid_request_error");
    if (model === "grok-video" && count > 7) throw new AdapterError(400, "grok-video supports at most 7 reference images", "invalid_request_error");
}

export function mapVideoTask(id: string, task: DuomiTask) {
    const state = fieldValue(task.state);
    if (state === "pending") return { id, status: "queued" };
    if (state === "running") return { id, status: "running" };
    if (state === "error") return { id, status: "failed", error: { message: fieldValue(task.message) || "Duomi video generation failed" } };
    if (state !== "succeeded") throw new AdapterError(502, `Duomi returned an unknown video task state${state ? `: ${state}` : ""}`, "invalid_upstream_response");
    const rawVideos = task.data?.videos;
    const url = Array.isArray(rawVideos) ? rawVideos.map((item) => (item && typeof item === "object" ? fieldValue((item as { url?: unknown }).url) : "")).find(Boolean) : "";
    if (!url) throw new AdapterError(502, "Duomi video task succeeded but returned no video", "invalid_upstream_response");
    return { id, status: "completed", url };
}

function sizeToRatio(value: string) {
    if (/^\d+x\d+$/i.test(value)) {
        const [width, height] = value.toLowerCase().split("x").map(Number);
        if (width && height) return closestRatio(width / height);
    }
    return value.includes(":") ? value : "16:9";
}

function closestRatio(ratio: number) {
    const options = ["2:3", "3:2", "1:1", "9:16", "16:9"];
    return options.reduce((best, current) => (Math.abs(parseRatio(current) - ratio) < Math.abs(parseRatio(best) - ratio) ? current : best));
}

function parseRatio(value: string) {
    const [width = 1, height = 1] = value.split(":").map(Number);
    return width / height;
}

function grokRatio(value: string) {
    return ["2:3", "3:2", "1:1", "9:16", "16:9"].includes(value) ? value : "16:9";
}

function fieldValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
