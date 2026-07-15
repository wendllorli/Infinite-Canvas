import type { FastifyPluginAsync } from "fastify";

import type { AdapterConfig } from "../types.js";

export function modelsRoutes(config: AdapterConfig): FastifyPluginAsync {
    return async (app) => {
        app.get("/v1/models", async () => ({
            object: "list",
            data: Array.from(new Set([config.imageModel, ...config.videoModels])).map((id) => ({ id, object: "model", owned_by: "duomi" })),
        }));
    };
}
