import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { DuomiClient } from "../src/duomi-client.js";
import type { AdapterConfig } from "../src/types.js";

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

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

function config(apiBase: string, overrides: Partial<AdapterConfig> = {}): AdapterConfig {
    return {
        port: 8787,
        apiBase,
        apiKey: "test-secret-key",
        authMode: "raw",
        pollIntervalMs: 1,
        timeoutMs: 500,
        imageModel: "gpt-image-2",
        videoModels: ["veo3.1-fast", "veo3.1-pro", "grok-video", "grok-video-1.5"],
        ...overrides,
    };
}

function json(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
}

async function injectGeneration(apiBase: string, overrides: Partial<AdapterConfig> = {}, payload: Record<string, unknown> = {}) {
    const adapterConfig = config(apiBase, overrides);
    const app = await buildApp(adapterConfig, { client: new DuomiClient(adapterConfig) });
    const response = await app.inject({
        method: "POST",
        url: "/v1/images/generations",
        payload: { model: "gpt-image-2", prompt: "a lighthouse", size: "16:9", quality: "high", n: 3, response_format: "b64_json", output_format: "png", ...payload },
    });
    await app.close();
    return response;
}

describe("V1 routes", () => {
    it("returns health and configured model", async () => {
        const app = await buildApp(config("http://127.0.0.1:1"));
        expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true, service: "duomi-adapter" });
        expect((await app.inject({ method: "GET", url: "/v1/models" })).json().data.map((item: { id: string }) => item.id)).toEqual(["gpt-image-2", "veo3.1-fast", "veo3.1-pro", "grok-video", "grok-video-1.5"]);
        await app.close();
    });

    it("creates a task, polls pending and running, then returns every image", async () => {
        let poll = 0;
        const base = await mockServer((request, response, body) => {
            if (request.method === "POST") {
                expect(request.url).toBe("/v1/images/generations?async=true");
                expect(JSON.parse(body)).toEqual({ model: "gpt-image-2", prompt: "a lighthouse", size: "16:9", quality: "high" });
                json(response, { id: "task-1" });
                return;
            }
            poll += 1;
            if (poll === 1) json(response, { id: "task-1", state: "pending", data: { images: [] } });
            else if (poll === 2) json(response, { id: "task-1", state: "running", data: { images: [] } });
            else json(response, { id: "task-1", state: "succeeded", data: { images: [{ url: "https://cdn.test/1.png" }, { url: "https://cdn.test/2.png" }] } });
        });
        const response = await injectGeneration(base);
        expect(response.statusCode).toBe(200);
        expect(response.json().data).toEqual([{ url: "https://cdn.test/1.png" }, { url: "https://cdn.test/2.png" }]);
        expect(response.json().created).toEqual(expect.any(Number));
    });

    it.each([
        ["raw", "test-secret-key"],
        ["bearer", "Bearer test-secret-key"],
    ] as const)("uses %s Authorization mode", async (authMode, expected) => {
        const headers: string[] = [];
        const base = await mockServer((request, response) => {
            headers.push(String(request.headers.authorization));
            if (request.method === "POST") json(response, { id: "auth-task" });
            else json(response, { state: "succeeded", data: { images: [{ url: "https://cdn.test/auth.png" }] } });
        });
        const response = await injectGeneration(base, { authMode });
        expect(response.statusCode).toBe(200);
        expect(headers).toEqual([expected, expected]);
    });

    it("returns a task error", async () => {
        const base = await mockServer((request, response) => {
            if (request.method === "POST") json(response, { id: "failed-task" });
            else json(response, { state: "error", message: "quota exhausted", data: { images: [] } });
        });
        const response = await injectGeneration(base);
        expect(response.statusCode).toBe(502);
        expect(response.json()).toEqual({ error: { message: "quota exhausted", type: "duomi_api_error" } });
    });

    it("times out while a task remains pending", async () => {
        const base = await mockServer((request, response) => {
            if (request.method === "POST") json(response, { id: "slow-task" });
            else json(response, { state: "pending", data: { images: [] } });
        });
        const response = await injectGeneration(base, { timeoutMs: 15, pollIntervalMs: 2 });
        expect(response.statusCode).toBe(504);
        expect(response.json()).toEqual({ error: { message: "Duomi image generation timed out", type: "upstream_timeout" } });
    });

    it("rejects a succeeded task without images", async () => {
        const base = await mockServer((request, response) => {
            if (request.method === "POST") json(response, { id: "empty-task" });
            else json(response, { state: "succeeded", data: { images: [] } });
        });
        const response = await injectGeneration(base);
        expect(response.statusCode).toBe(502);
        expect(response.json().error.type).toBe("invalid_upstream_response");
    });

    it("converts an HTML 404 into JSON without exposing HTML", async () => {
        const base = await mockServer((_request, response) => {
            response.writeHead(404, { "Content-Type": "text/html" });
            response.end("<html>not found</html>");
        });
        const response = await injectGeneration(base);
        expect(response.statusCode).toBe(404);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.body).not.toContain("<html>");
        expect(response.json().error).toEqual({ message: "Duomi API request failed with status 404", type: "duomi_api_error", status: 404 });
    });

    it("preserves an upstream 401 status and JSON message", async () => {
        const base = await mockServer((_request, response) => json(response, { error: { message: "invalid key" } }, 401));
        const response = await injectGeneration(base);
        expect(response.statusCode).toBe(401);
        expect(response.json().error).toEqual({ message: "invalid key", type: "duomi_api_error", status: 401 });
    });

    it("rejects a create response without a task id", async () => {
        const base = await mockServer((_request, response) => json(response, {}));
        const response = await injectGeneration(base);
        expect(response.statusCode).toBe(502);
        expect(response.json().error.type).toBe("invalid_upstream_response");
    });
});
