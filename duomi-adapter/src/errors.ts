import type { AdapterConfig } from "./types.js";

export function assertDuomiKey(config: Pick<AdapterConfig, "apiKey">) {
    if (!config.apiKey) throw new AdapterError(503, "DUOMI_API_KEY is not configured", "configuration_error");
}

export class AdapterError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly type: string,
        readonly upstreamStatus?: number,
    ) {
        super(message);
        this.name = "AdapterError";
    }
}
