import type { FastifyPluginAsync } from "fastify";

import { AdapterError } from "../errors.js";
import { fetchDuomiResultImage, MAX_RESULT_IMAGE_BYTES } from "../media-proxy.js";

export function mediaRoutes(fetchImpl?: typeof fetch): FastifyPluginAsync {
    return async (app) => {
        app.get<{ Querystring: { url?: string } }>("/v1/media", async (request, reply) => {
            const upstream = await fetchDuomiResultImage(request.query.url, fetchImpl || fetch);
            const bytes = Buffer.from(await upstream.arrayBuffer());
            if (bytes.byteLength > MAX_RESULT_IMAGE_BYTES) throw new AdapterError(502, "Duomi result image exceeds 30 MB", "invalid_upstream_response");
            return reply
                .header("Content-Type", upstream.headers.get("content-type") || "image/png")
                .header("Cache-Control", "private, max-age=300")
                .send(bytes);
        });
    };
}
