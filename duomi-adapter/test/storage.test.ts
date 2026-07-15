import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { S3ReferenceStorage } from "../src/storage.js";

describe("S3-compatible storage", () => {
    it("uploads a file and returns its public R2 URL", async () => {
        let requestPath = "";
        let contentType = "";
        let uploaded = Buffer.alloc(0);
        const server = createServer(async (request, response) => {
            requestPath = request.url || "";
            contentType = String(request.headers["content-type"] || "");
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            uploaded = Buffer.concat(chunks);
            response.writeHead(200, { ETag: '"mock-etag"' });
            response.end();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("mock S3 server did not start");
        const directory = await mkdtemp(join(tmpdir(), "duomi-storage-test-"));
        const filepath = join(directory, "reference.png");
        await writeFile(filepath, new Uint8Array([137, 80, 78, 71]));
        try {
            const storage = new S3ReferenceStorage({
                endpoint: `http://127.0.0.1:${address.port}`,
                region: "auto",
                bucket: "canvas-bucket",
                accessKey: "access-key",
                secretKey: "secret-key",
                publicBaseUrl: "https://images.example.com",
                forcePathStyle: true,
            });
            const url = await storage.upload({ filepath, filename: "reference.png", mimetype: "image/png" });
            expect(url).toMatch(/^https:\/\/images\.example\.com\/duomi-references\/[0-9a-f-]+\.png$/);
            expect(requestPath).toMatch(/^\/canvas-bucket\/duomi-references\/[0-9a-f-]+\.png\?/);
            expect(contentType).toBe("image/png");
            expect(uploaded.indexOf(Buffer.from([137, 80, 78, 71]))).toBeGreaterThanOrEqual(0);
        } finally {
            await rm(directory, { recursive: true, force: true });
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
