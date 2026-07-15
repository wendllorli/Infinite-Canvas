import { resolve } from "node:path";
import { File } from "node:buffer";

import { FormData as RuntimeFormData, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultImageUpstreamRequestBudget, handleRequest, type Env } from "../src/index";

const bindings = {
    DUOMI_API_BASE: "https://duomi.test",
    DUOMI_API_KEY: "worker-test-secret",
    DUOMI_AUTH_MODE: "raw",
    DUOMI_POLL_INTERVAL_MS: "7000",
    DUOMI_TIMEOUT_MS: "300000",
    DUOMI_IMAGE_MODEL: "gpt-image-2",
    DUOMI_VIDEO_MODELS: "veo3.1-fast,veo3.1-pro,grok-video,grok-video-1.5",
    STORAGE_PUBLIC_BASE_URL: "https://media.example.com",
};

let runtime: Miniflare;

beforeAll(() => {
    runtime = new Miniflare({
        modules: true,
        scriptPath: resolve("dist-test/index.js"),
        compatibilityDate: "2026-07-15",
        r2Buckets: ["REFERENCES"],
        bindings,
    });
});

afterAll(async () => runtime.dispose());

function image(name = "reference.png", bytes: string | Uint8Array<ArrayBuffer> = new Uint8Array([137, 80, 78, 71]), type = "image/png") {
    return new File([bytes], name, { type });
}

function directEnv(overrides: Partial<Env> = {}): Env {
    return { ...bindings, REFERENCES: {} as R2Bucket, ...overrides };
}

describe("Cloudflare Worker routes", () => {
    it("serves health and models without exposing the secret", async () => {
        const health = await runtime.dispatchFetch("https://canvas.test/api/duomi/health");
        expect(await health.json()).toEqual({ ok: true, service: "duomi-adapter" });
        const models = await runtime.dispatchFetch("https://canvas.test/api/duomi/v1/models");
        const body = await models.text();
        expect(JSON.parse(body).data[0].id).toBe("gpt-image-2");
        expect(body).not.toContain("worker-test-secret");
    });

    it("uploads one image to the Miniflare R2 binding", async () => {
        const form = new RuntimeFormData();
        form.set("image", image());
        const response = await runtime.dispatchFetch("https://canvas.test/api/duomi/v1/uploads", { method: "POST", body: form as never });
        expect(response.status, await response.clone().text()).toBe(200);
        const { url } = (await response.json()) as { url: string };
        expect(url).toMatch(/^https:\/\/media\.example\.com\/duomi-references\/[0-9a-f-]+\.png$/);
        const key = new URL(url).pathname.slice(1);
        const stored = await (await runtime.getR2Bucket("REFERENCES")).get(key);
        expect(stored).not.toBeNull();
        expect(stored?.httpMetadata?.contentType).toBe("image/png");
        await stored?.arrayBuffer();
    });

    it("uploads a raw image body to the Miniflare R2 binding", async () => {
        const response = await runtime.dispatchFetch("https://canvas.test/api/duomi/v1/uploads", {
            method: "POST",
            headers: { "Content-Type": "image/png" },
            body: new Uint8Array([137, 80, 78, 71]),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const { url } = (await response.json()) as { url: string };
        expect(url).toMatch(/^https:\/\/media\.example\.com\/duomi-references\/[0-9a-f-]+\.png$/);
    });

    it("rejects invalid and oversized uploads as JSON", async () => {
        const invalid = new RuntimeFormData();
        invalid.set("image", image("reference.txt", "text", "text/plain"));
        const invalidResponse = await runtime.dispatchFetch("https://canvas.test/api/duomi/v1/uploads", { method: "POST", body: invalid as never });
        expect(invalidResponse.status).toBe(400);
        expect(((await invalidResponse.json()) as { error: { type: string } }).error.type).toBe("invalid_request_error");

        const oversized = new RuntimeFormData();
        oversized.set("image", image("large.png", new Uint8Array(20 * 1024 * 1024 + 1)));
        const oversizedResponse = await runtime.dispatchFetch("https://canvas.test/api/duomi/v1/uploads", { method: "POST", body: oversized as never });
        expect(oversizedResponse.status, await oversizedResponse.clone().text()).toBe(413);
        await oversizedResponse.arrayBuffer();
    });

    it("converts a JSON reference edit through the shared Duomi client", async () => {
        const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
        let poll = 0;
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input);
            calls.push({ url, authorization: new Headers(init?.headers).get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url.endsWith("?async=true")) return Response.json({ id: "worker-image-task" });
            poll += 1;
            return Response.json(poll === 1 ? { state: "running" } : { state: "succeeded", data: { images: [{ url: "https://cdn.test/one.png" }, { url: "https://cdn.test/two.png" }] } });
        };
        const response = await handleRequest(
            new Request("https://canvas.test/api/duomi/v1/images/edits", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "gpt-image-2", prompt: "edit", image: ["https://media.example.com/a.png", "https://media.example.com/b.png"] }),
            }),
            directEnv({ DUOMI_POLL_INTERVAL_MS: "1", DUOMI_TIMEOUT_MS: "100" }),
            fetchImpl,
        );
        expect(response.status).toBe(200);
        expect(((await response.json()) as { data: Array<{ url: string }> }).data).toEqual([{ url: "https://cdn.test/one.png" }, { url: "https://cdn.test/two.png" }]);
        expect(calls[0]).toMatchObject({ authorization: "worker-test-secret", body: { model: "gpt-image-2", prompt: "edit", image: ["https://media.example.com/a.png", "https://media.example.com/b.png"] } });
    });

    it("rejects mask edits and supports JSON video references", async () => {
        const masked = await runtime.dispatchFetch("https://canvas.test/api/duomi/v1/images/edits", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "inpaint", image: ["https://media.example.com/a.png"], mask: true }),
        });
        expect(masked.status).toBe(400);
        expect(((await masked.json()) as { error: { type: string } }).error.type).toBe("unsupported_feature");

        let payload: unknown;
        const response = await handleRequest(
            new Request("https://canvas.test/api/duomi/v1/videos", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "veo3.1-fast", prompt: "move", size: "16:9", resolution_name: "1080p", image_urls: ["https://media.example.com/first.png", "https://media.example.com/last.png"] }),
            }),
            directEnv(),
            async (_input, init) => {
                payload = JSON.parse(String(init?.body));
                return Response.json({ id: "video-task" });
            },
        );
        expect(response.status).toBe(200);
        expect(payload).toMatchObject({ model: "veo3.1-fast", generation_type: "FIRST&LAST", image_urls: ["https://media.example.com/first.png", "https://media.example.com/last.png"] });
    });

    it("delegates non-API routes to the static asset binding", async () => {
        const testEnv = directEnv({ ASSETS: { fetch: async () => new Response("spa-index") } as unknown as Fetcher });
        const response = await handleRequest(new Request("https://canvas.test/canvas/project-1"), testEnv);
        expect(await response.text()).toBe("spa-index");
    });

    it("keeps the default five-minute image poll budget within 50 upstream requests", () => {
        expect(defaultImageUpstreamRequestBudget()).toBeLessThanOrEqual(50);
    });
});
