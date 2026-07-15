import { AdapterError, assertDuomiKey } from "./errors.js";
import type { AdapterConfig, DuomiCreatedTask, DuomiImageRequest, DuomiMedia, DuomiTask, DuomiVideoRequest } from "./types.js";

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
        const deadline = this.now() + this.config.timeoutMs;
        const created = await this.requestJson<DuomiCreatedTask>("/v1/images/generations?async=true", { method: "POST", body: JSON.stringify(input) }, deadline);
        const id = stringValue(created.id);
        if (!id) throw new AdapterError(502, "Duomi image generation did not return a task id", "invalid_upstream_response");

        for (;;) {
            if (this.now() >= deadline) throw timeoutError();
            const task = await this.requestJson<DuomiTask>(`/v1/tasks/${encodeURIComponent(id)}`, { method: "GET" }, deadline);
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
        const created = await this.requestJson<DuomiCreatedTask>("/v1/videos/generations", { method: "POST", body: JSON.stringify(input) }, deadline);
        const id = stringValue(created.id);
        if (!id) throw new AdapterError(502, "Duomi video generation did not return a task id", "invalid_upstream_response");
        return id;
    }

    async getVideoTask(id: string) {
        assertDuomiKey(this.config);
        return this.requestJson<DuomiTask>(`/v1/videos/tasks/${encodeURIComponent(id)}`, { method: "GET" }, this.now() + this.config.timeoutMs);
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

function timeoutError() {
    return new AdapterError(504, "Duomi image generation timed out", "upstream_timeout");
}
