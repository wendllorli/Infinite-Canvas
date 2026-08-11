import { AdapterError, assertDuomiKey } from "./errors.js";
import { isNanoBananaModel, nanoBananaImageSize } from "./nano-banana.js";
import type { AdapterConfig, DuomiCreatedTask, DuomiImageRequest, DuomiKlingTask, DuomiMedia, DuomiTask, DuomiVideoRequest, DuomiVideoTaskResult } from "./types.js";

type ClientDependencies = {
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
};

export type ImageResult = { created: number; data: Array<{ url: string }> };

export class DuomiClient {
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;

    constructor(
        private readonly config: AdapterConfig,
        dependencies: ClientDependencies = {},
    ) {
        // Cloudflare's global fetch must be called as a plain function. Keeping
        // it directly on the client and invoking `this.fetchImpl(...)` gives it
        // the client as `this`, which production Workers reject.
        const fetchImpl = dependencies.fetch;
        this.fetchImpl = fetchImpl
            ? (input, init) => fetchImpl(input, init)
            : (input, init) => fetch(input, init);
        this.sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = dependencies.now || Date.now;
    }

    async generateImages(input: DuomiImageRequest): Promise<ImageResult> {
        assertDuomiKey(this.config);
        const nanoBanana = isNanoBananaModel(input.model);
        const count = nanoBanana ? imageCount(input.n) : 1;
        if (count === 1) return this.generateImage(input, nanoBanana);

        const results = await Promise.all(Array.from({ length: count }, () => this.generateImage(input, nanoBanana)));
        return { created: Math.floor(this.now() / 1000), data: results.flatMap((result) => result.data) };
    }

    private async generateImage(input: DuomiImageRequest, nanoBanana: boolean): Promise<ImageResult> {
        const deadline = this.now() + this.config.timeoutMs;
        const created = await this.requestJson<DuomiCreatedTask>(nanoBanana ? nanoBananaPath(input) : "/v1/images/generations?async=true", { method: "POST", body: JSON.stringify(nanoBanana ? nanoBananaRequest(input) : input) }, deadline);
        const id = taskId(created);
        if (!id) throw new AdapterError(502, "Duomi image generation did not return a task id", "invalid_upstream_response");

        for (;;) {
            if (this.now() >= deadline) throw timeoutError();
            const response = await this.requestJson<DuomiTask>(nanoBanana ? `/api/gemini/nano-banana/${encodeURIComponent(id)}` : `/v1/tasks/${encodeURIComponent(id)}`, { method: "GET" }, deadline);
            const task = nanoBanana ? unwrapNanoBananaTask(response) : response;
            const state = stringValue(task.state);
            if (state === "succeeded") return imageResult(task);
            if (state === "error") throw new AdapterError(502, taskErrorMessage(task, "Duomi image generation failed"), "duomi_api_error");
            if (state !== "pending" && state !== "running") {
                throw new AdapterError(502, `Duomi returned an unknown task state${state ? `: ${state}` : ""}`, "invalid_upstream_response");
            }
            const remaining = deadline - this.now();
            if (remaining <= 0) throw timeoutError();
            await this.sleep(Math.min(this.config.pollIntervalMs, remaining));
        }
    }

    async createVideo(input: DuomiVideoRequest) {
        assertDuomiKey(this.config);
        const deadline = this.now() + this.config.timeoutMs;
        const kling = "model_name" in input;
        const omni = kling && "sound" in input;
        const path = omni ? "/api/video/kling/v1/videos/omni-video" : kling ? "/api/video/kling/v1/videos/multi-image2video" : "/v1/videos/generations";
        const created = await this.requestJson<DuomiCreatedTask>(path, { method: "POST", body: JSON.stringify(input) }, deadline);
        assertSuccessfulEnvelope(created, "Duomi Kling video generation failed");
        const id = taskId(created);
        if (!id) throw new AdapterError(502, "Duomi video generation did not return a task id", "invalid_upstream_response");
        return omni ? `omni:${id}` : kling ? `kling:${id}` : id;
    }

    async getVideoTask(id: string): Promise<DuomiVideoTaskResult> {
        assertDuomiKey(this.config);
        if (id.startsWith("omni:")) {
            const upstreamId = id.slice("omni:".length).trim();
            if (!upstreamId) throw new AdapterError(400, "Kling Omni task id is invalid", "invalid_request_error");
            const task = await this.requestJson<DuomiKlingTask>(`/api/video/kling/v1/videos/omni-video/${encodeURIComponent(upstreamId)}`, { method: "GET" }, this.now() + this.config.timeoutMs);
            assertSuccessfulEnvelope(task, "Duomi Kling Omni task query failed");
            return { provider: "kling", task };
        }
        if (id.startsWith("kling:")) {
            const upstreamId = id.slice("kling:".length).trim();
            if (!upstreamId) throw new AdapterError(400, "Kling task id is invalid", "invalid_request_error");
            const task = await this.requestJson<DuomiKlingTask>(`/api/video/kling/v1/videos/multi-image2video/${encodeURIComponent(upstreamId)}`, { method: "GET" }, this.now() + this.config.timeoutMs);
            assertSuccessfulEnvelope(task, "Duomi Kling task query failed");
            return { provider: "kling", task };
        }
        const task = await this.requestJson<DuomiTask>(`/v1/videos/tasks/${encodeURIComponent(id)}`, { method: "GET" }, this.now() + this.config.timeoutMs);
        return { provider: "standard", task };
    }

    private async requestJson<T>(path: string, init: RequestInit, deadline: number): Promise<T> {
        const remaining = deadline - this.now();
        if (remaining <= 0) throw timeoutError();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        let response: Response;
        try {
            response = await this.fetchImpl(`${this.config.apiBase}${path}`, {
                ...init,
                headers: {
                    Authorization: this.config.authMode === "bearer" ? `Bearer ${this.config.apiKey}` : this.config.apiKey,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    ...init.headers,
                },
                signal: controller.signal,
            });
        } catch (error) {
            if (controller.signal.aborted || this.now() >= deadline) throw timeoutError();
            throw new AdapterError(502, error instanceof Error ? `Duomi network error: ${error.message}` : "Duomi network error", "duomi_api_error");
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        if (!response.ok) {
            const message = jsonErrorMessage(text) || `Duomi API request failed with status ${response.status}`;
            const downstreamStatus = [400, 401, 403, 404, 429].includes(response.status) ? response.status : 502;
            throw new AdapterError(downstreamStatus, message, "duomi_api_error", response.status);
        }
        if (!text.trim()) throw new AdapterError(502, "Duomi API returned an empty response", "invalid_upstream_response");
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new AdapterError(502, "Duomi API returned invalid JSON", "invalid_upstream_response");
        }
    }
}

function nanoBananaPath(input: DuomiImageRequest) {
    return input.image?.length ? "/api/gemini/nano-banana-edit" : "/api/gemini/nano-banana";
}

function imageCount(value: number | undefined) {
    return Math.max(1, Math.min(15, Math.floor(value || 1)));
}

function nanoBananaRequest(input: DuomiImageRequest) {
    const imageSize = nanoBananaImageSize(input.quality);
    return {
        model: input.model,
        prompt: input.prompt,
        ...(input.image?.length ? { image_urls: input.image } : {}),
        ...(input.size ? { aspect_ratio: input.size } : {}),
        ...(imageSize ? { image_size: imageSize } : {}),
    };
}

function unwrapNanoBananaTask(response: DuomiTask): DuomiTask {
    const data = response.data;
    return data && typeof data === "object" && ("state" in data || "status" in data) ? (data as unknown as DuomiTask) : response;
}

function imageResult(task: DuomiTask): ImageResult {
    const rawImages = task.data?.images;
    const images = Array.isArray(rawImages)
        ? rawImages.flatMap((item): Array<{ url: string }> => {
              if (!item || typeof item !== "object") return [];
              const url = stringValue((item as DuomiMedia).url);
              return url ? [{ url }] : [];
          })
        : [];
    if (!images.length) throw new AdapterError(502, "Duomi task succeeded but returned no images", "invalid_upstream_response");
    return { created: Math.floor(Date.now() / 1000), data: images };
}

function taskErrorMessage(task: DuomiTask, fallback: string) {
    return stringValue(task.message) || stringValue(task.data?.description) || fallback;
}

function jsonErrorMessage(text: string) {
    if (!text.trim()) return "";
    try {
        const value = JSON.parse(text) as unknown;
        return nestedMessage(value);
    } catch {
        return "";
    }
}

function nestedMessage(value: unknown): string {
    if (typeof value === "string") return value.length <= 300 ? value : value.slice(0, 300);
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    return nestedMessage(record.message) || nestedMessage(record.msg) || nestedMessage(record.error);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function taskId(created: DuomiCreatedTask) {
    return stringValue(created.id) || stringValue(created.task_id) || stringValue(created.data?.id) || stringValue(created.data?.task_id);
}

function assertSuccessfulEnvelope(value: { code?: unknown; message?: unknown; msg?: unknown }, fallback: string) {
    if (value.code === undefined || value.code === null || value.code === "") return;
    const code = typeof value.code === "number" ? value.code : Number(value.code);
    if (code === 0 || code === 200) return;
    throw new AdapterError(502, stringValue(value.message) || stringValue(value.msg) || fallback, "duomi_api_error");
}

function timeoutError() {
    return new AdapterError(504, "Duomi image generation timed out", "upstream_timeout");
}
