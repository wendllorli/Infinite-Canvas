import type { FastifyPluginAsync } from "fastify";

import type { AdapterConfig } from "../types.js";
import { NANO_BANANA_MODELS } from "../nano-banana.js";

export function modelsRoutes(config: AdapterConfig): FastifyPluginAsync {
    return async (app) => {
        app.get("/v1/models", async () => ({
            object: "list",
            data: Array.from(new Set([config.imageModel, ...NANO_BANANA_MODELS, ...config.videoModels])).map((id) => ({ id, object: "model", owned_by: "duomi" })),
        }));
    };
}
