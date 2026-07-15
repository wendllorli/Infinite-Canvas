import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { DuomiClient } from "../src/duomi-client.js";
import { AdapterError } from "../src/errors.js";
import type { ReferenceStorage, UploadFile } from "../src/storage.js";
import type { AdapterConfig } from "../src/types.js";

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;
const servers: Server[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

class FakeStorage implements ReferenceStorage {
    readonly files: Array<UploadFile & { existed: boolean }> = [];

    async upload(file: UploadFile) {
        this.files.push({ ...file, existed: existsSync(file.filepath) });
        return `https://r2.test/duomi-references/${this.files.length}-${encodeURIComponent(file.filename)}`;
    }
}

class FailingStorage extends FakeStorage {
    override async upload(_file: UploadFile): Promise<string> {
        throw new AdapterError(502, "Reference image upload failed", "storage_error");
    }
}

async function mockServer(handler: Handler) {
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        handler(request, response, Buffer.concat(chunks).toString("utf8"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    return `http://127.0.0.1:${address.port}`;
}

function config(apiBase: string): AdapterConfig {
    return {
        port: 8787,
        apiBase,
        apiKey: "test-secret-key",
        authMode: "raw",
        pollIntervalMs: 1,
        timeoutMs: 500,
        imageModel: "gpt-image-2",
        videoModels: ["veo3.1-fast", "veo3.1-pro", "grok-video", "grok-video-1.5"],
    };
}

function json(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
}

async function startAdapter(apiBase: string, storage = new FakeStorage()) {
    const adapterConfig = config(apiBase);
    const app = await buildApp(adapterConfig, { client: new DuomiClient(adapterConfig), storage });
    await app.listen({ host: "127.0.0.1", port: 0 });
    apps.push(app);
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("adapter did not start");
    return { base: `http://127.0.0.1:${address.port}`, storage };
}

function image(name: string) {
    return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
}

describe("V2 image edits", () => {
    it.each([1, 3])("uploads and forwards %i reference image(s)", async (count) => {
        let submitted: Record<string, unknown> | undefined;
        const upstream = await mockServer((request, response, body) => {
            if (request.method === "POST") {
                submitted = JSON.parse(body) as Record<string, unknown>;
                json(response, { id: "edit-task" });
            } else {
                json(response, { state: "succeeded", data: { images: [{ url: "https://cdn.test/edited.png" }] } });
            }
        });
        const { base, storage } = await startAdapter(upstream);
        const form = new FormData();
        form.set("model", "gpt-image-2");
        form.set("prompt", "change the background");
        form.set("size", "16:9");
        form.set("quality", "high");
        form.set("n", "4");
        for (let index = 0; index < count; index += 1) form.append("image", image(`reference-${index + 1}.png`));
        const response = await fetch(`${base}/v1/images/edits`, { method: "POST", body: form });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ data: [{ url: "https://cdn.test/edited.png" }] });
        expect(submitted).toEqual({
            model: "gpt-image-2",
            prompt: "change the background",
            size: "16:9",
            quality: "high",
            image: Array.from({ length: count }, (_, index) => `https://r2.test/duomi-references/${index + 1}-reference-${index + 1}.png`),
        });
        expect(storage.files).toHaveLength(count);
        expect(storage.files.every((file) => file.existed && !existsSync(file.filepath))).toBe(true);
    });

    it("rejects mask before uploading any image", async () => {
        const upstream = await mockServer((_request, response) => json(response, { id: "should-not-run" }));
        const { base, storage } = await startAdapter(upstream);
        const form = new FormData();
        form.set("model", "gpt-image-2");
        form.set("prompt", "inpaint");
        form.append("image", image("reference.png"));
        form.append("mask", image("mask.png"));
        const response = await fetch(`${base}/v1/images/edits`, { method: "POST", body: form });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: { message: "Duomi API does not currently support mask-based inpainting", type: "unsupported_feature" } });
        expect(storage.files).toHaveLength(0);
    });

    it.each([1, 3])("forwards %i pre-uploaded public image URL(s)", async (count) => {
        let submitted: Record<string, unknown> | undefined;
        const upstream = await mockServer((request, response, body) => {
            if (request.method === "POST") {
                submitted = JSON.parse(body) as Record<string, unknown>;
                json(response, { id: "json-edit-task" });
            } else {
                json(response, { state: "succeeded", data: { images: [{ url: "https://cdn.test/json-edit.png" }] } });
            }
        });
        const { base, storage } = await startAdapter(upstream);
        const urls = Array.from({ length: count }, (_, index) => `https://media.example.com/duomi-references/${index + 1}.png`);
        const response = await fetch(`${base}/v1/images/edits`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gpt-image-2", prompt: "change the sky", size: "16:9", quality: "high", image: urls }),
        });
        expect(response.status).toBe(200);
        expect(submitted).toEqual({ model: "gpt-image-2", prompt: "change the sky", size: "16:9", quality: "high", image: urls });
        expect(storage.files).toHaveLength(0);
    });
});

describe("reference uploads", () => {
    it("uploads exactly one supported image", async () => {
        const upstream = await mockServer((_request, response) => json(response, {}));
        const { base, storage } = await startAdapter(upstream);
        const form = new FormData();
        form.set("image", image("upload.png"));
        const response = await fetch(`${base}/v1/uploads`, { method: "POST", body: form });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ url: "https://r2.test/duomi-references/1-upload.png" });
        expect(storage.files).toHaveLength(1);
    });

    it("rejects unsupported MIME types and images over 20 MB", async () => {
        const upstream = await mockServer((_request, response) => json(response, {}));
        const { base } = await startAdapter(upstream);
        const invalid = new FormData();
        invalid.set("image", new File(["text"], "reference.txt", { type: "text/plain" }));
        const invalidResponse = await fetch(`${base}/v1/uploads`, { method: "POST", body: invalid });
        expect(invalidResponse.status).toBe(400);
        expect((await invalidResponse.json()).error.message).toContain("Unsupported image type");

        const oversized = new FormData();
        oversized.set("image", new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }));
        const oversizedResponse = await fetch(`${base}/v1/uploads`, { method: "POST", body: oversized });
        expect(oversizedResponse.status).toBe(413);
    });

    it("returns a JSON storage error", async () => {
        const upstream = await mockServer((_request, response) => json(response, {}));
        const { base } = await startAdapter(upstream, new FailingStorage());
        const form = new FormData();
        form.set("image", image("failure.png"));
        const response = await fetch(`${base}/v1/uploads`, { method: "POST", body: form });
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: { message: "Reference image upload failed", type: "storage_error" } });
    });
});

describe("video adapter", () => {
    it("creates and polls a text-only Grok video", async () => {
        let submitted: Record<string, unknown> | undefined;
        const upstream = await mockServer((request, response, body) => {
            if (request.method === "POST") {
                submitted = JSON.parse(body) as Record<string, unknown>;
                json(response, { id: "video-task" });
            } else {
                expect(request.url).toBe("/v1/videos/tasks/video-task");
                json(response, { id: "video-task", state: "succeeded", data: { videos: [{ url: "https://cdn.test/video.mp4" }] } });
            }
        });
        const { base } = await startAdapter(upstream);
        const form = new FormData();
        form.set("model", "grok-video-1.5");
        form.set("prompt", "a car driving through rain");
        form.set("seconds", "10");
        form.set("size", "1280x720");
        form.set("resolution_name", "1080p");
        const created = await fetch(`${base}/v1/videos`, { method: "POST", body: form });
        expect(created.status).toBe(200);
        expect(await created.json()).toEqual({ id: "video-task", status: "queued" });
        expect(submitted).toEqual({ model: "grok-video-1.5", prompt: "a car driving through rain", aspect_ratio: "16:9", duration: 10, quality: "720p" });
        const polled = await fetch(`${base}/v1/videos/video-task`);
        expect(await polled.json()).toEqual({ id: "video-task", status: "completed", url: "https://cdn.test/video.mp4" });
    });

    it("rejects Grok durations outside the fixed 6, 10, and 15 second options", async () => {
        const upstream = await mockServer((_request, response) => json(response, { id: "unexpected-task" }));
        const { base } = await startAdapter(upstream);
        const response = await fetch(`${base}/v1/videos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "grok-video", prompt: "move", seconds: "20", size: "16:9", resolution_name: "720p", image_urls: [] }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: { message: "grok-video duration must be one of: 6, 10, 15", type: "invalid_request_error" } });
    });

    it("uploads VEO first and last frame references", async () => {
        let submitted: Record<string, unknown> | undefined;
        const upstream = await mockServer((request, response, body) => {
            submitted = JSON.parse(body) as Record<string, unknown>;
            json(response, { id: "veo-task" });
        });
        const { base, storage } = await startAdapter(upstream);
        const form = new FormData();
        form.set("model", "veo3.1-fast");
        form.set("prompt", "camera moves between frames");
        form.set("seconds", "6");
        form.set("size", "1280x720");
        form.set("resolution_name", "1080p");
        form.append("input_reference[]", image("first.png"));
        form.append("input_reference[]", image("last.png"));
        const response = await fetch(`${base}/v1/videos`, { method: "POST", body: form });
        expect(response.status).toBe(200);
        expect(submitted).toEqual({
            model: "veo3.1-fast",
            prompt: "camera moves between frames",
            aspect_ratio: "16:9",
            duration: 8,
            quality: "1080p",
            generation_type: "FIRST&LAST",
            image_urls: ["https://r2.test/duomi-references/1-first.png", "https://r2.test/duomi-references/2-last.png"],
        });
        expect(storage.files).toHaveLength(2);
    });

    it("accepts pre-uploaded VEO reference URLs as JSON", async () => {
        let submitted: Record<string, unknown> | undefined;
        const upstream = await mockServer((_request, response, body) => {
            submitted = JSON.parse(body) as Record<string, unknown>;
            json(response, { id: "veo-json-task" });
        });
        const { base, storage } = await startAdapter(upstream);
        const image_urls = ["https://media.example.com/first.png", "https://media.example.com/last.png"];
        const response = await fetch(`${base}/v1/videos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "veo3.1-fast", prompt: "camera moves", size: "1280x720", resolution_name: "1080p", image_urls }),
        });
        expect(response.status).toBe(200);
        expect(submitted).toEqual({
            model: "veo3.1-fast",
            prompt: "camera moves",
            aspect_ratio: "16:9",
            duration: 8,
            quality: "1080p",
            generation_type: "FIRST&LAST",
            image_urls,
        });
        expect(storage.files).toHaveLength(0);
    });
});
