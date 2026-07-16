import "dotenv/config";

import type { AdapterConfig, AuthMode, StorageConfig } from "./types.js";
export { AdapterError, assertDuomiKey } from "./errors.js";

function positiveInteger(name: string, fallback: number) {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}

function authMode(): AuthMode {
    const value = process.env.DUOMI_AUTH_MODE?.trim().toLowerCase() || "raw";
    if (value !== "raw" && value !== "bearer") throw new Error("DUOMI_AUTH_MODE must be raw or bearer");
    return value;
}

export function loadConfig(): AdapterConfig {
    return {
        port: positiveInteger("PORT", 8787),
        apiBase: (process.env.DUOMI_API_BASE?.trim() || "https://duomiapi.com").replace(/\/+$/, ""),
        apiKey: process.env.DUOMI_API_KEY?.trim() || "",
        authMode: authMode(),
        pollIntervalMs: positiveInteger("DUOMI_POLL_INTERVAL_MS", 15000),
        timeoutMs: positiveInteger("DUOMI_TIMEOUT_MS", 600000),
        imageModel: process.env.DUOMI_IMAGE_MODEL?.trim() || "gpt-image-2",
        videoModels: csv("DUOMI_VIDEO_MODELS", ["veo3.1-fast", "veo3.1-pro", "grok-video", "grok-video-1.5", "kling-v1-6"]),
        storage: storageConfig(),
    };
}

function csv(name: string, fallback: string[]) {
    const values = process.env[name]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    return values?.length ? Array.from(new Set(values)) : fallback;
}

function storageConfig(): StorageConfig | undefined {
    const values = {
        endpoint: process.env.STORAGE_ENDPOINT?.trim() || "",
        region: process.env.STORAGE_REGION?.trim() || "auto",
        bucket: process.env.STORAGE_BUCKET?.trim() || "",
        accessKey: process.env.STORAGE_ACCESS_KEY?.trim() || "",
        secretKey: process.env.STORAGE_SECRET_KEY?.trim() || "",
        publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || "",
        forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE?.trim().toLowerCase() === "true",
    };
    const configured = values.endpoint || values.bucket || values.accessKey || values.secretKey || values.publicBaseUrl;
    return configured ? values : undefined;
}
