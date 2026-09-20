import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";

import { AdapterError } from "./errors.js";
import { DuomiClient } from "./duomi-client.js";
import { healthRoutes } from "./routes/health.js";
import { imageRoutes } from "./routes/images.js";
import { modelsRoutes } from "./routes/models.js";
import { mediaRoutes } from "./routes/media.js";
import { videoRoutes } from "./routes/videos.js";
import { uploadRoutes } from "./routes/uploads.js";
import { S3ReferenceStorage, type ReferenceStorage } from "./storage.js";
import type { AdapterConfig, AdapterErrorBody } from "./types.js";

type AppDependencies = { client?: DuomiClient; storage?: ReferenceStorage; fetch?: typeof fetch };

export async function buildApp(config: AdapterConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
    const app = Fastify({ logger: true, bodyLimit: 200 * 1024 * 1024 });
    const client = dependencies.client || new DuomiClient(config);
    const storage = dependencies.storage || (config.storage ? new S3ReferenceStorage(config.storage) : undefined);

    app.setErrorHandler((error, request, reply) => {
        if (error instanceof AdapterError) {
            const body: AdapterErrorBody = {
                error: {
                    message: error.message,
                    type: error.type,
                    ...(error.upstreamStatus !== undefined ? { status: error.upstreamStatus } : {}),
                },
            };
            return reply.status(error.statusCode).send(body);
        }
        const unknownError = error as { statusCode?: unknown; message?: unknown };
        const statusCode = typeof unknownError.statusCode === "number" && unknownError.statusCode >= 400 && unknownError.statusCode < 500 ? unknownError.statusCode : 500;
        const message = typeof unknownError.message === "string" ? unknownError.message : "Invalid request";
        request.log.error({ err: error }, "request failed");
        const body: AdapterErrorBody = {
            error: {
                message: statusCode === 500 ? "Internal server error" : message,
                type: statusCode === 500 ? "internal_error" : "invalid_request_error",
            },
        };
        return reply.status(statusCode).send(body);
    });

    await app.register(multipart);
    await app.register(healthRoutes);
    await app.register(modelsRoutes(config));
    await app.register(mediaRoutes(dependencies.fetch));
    await app.register(imageRoutes(config, client, storage));
    await app.register(videoRoutes(config, client, storage));
    await app.register(uploadRoutes(storage));
    return app;
}
