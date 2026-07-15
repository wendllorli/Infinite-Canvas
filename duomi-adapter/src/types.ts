export type AuthMode = "raw" | "bearer";

export type AdapterConfig = {
    port: number;
    apiBase: string;
    apiKey: string;
    authMode: AuthMode;
    pollIntervalMs: number;
    timeoutMs: number;
    imageModel: string;
    videoModels: string[];
    storage?: StorageConfig;
};

export type StorageConfig = {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    publicBaseUrl: string;
    forcePathStyle: boolean;
};

export type ImageGenerationRequest = {
    model?: string;
    prompt?: string;
    size?: string;
    quality?: string;
    n?: number;
    response_format?: string;
    output_format?: string;
};

export type ImageEditJsonRequest = ImageGenerationRequest & {
    image?: string[];
    mask?: unknown;
};

export type VideoJsonRequest = {
    model?: string;
    prompt?: string;
    seconds?: string | number;
    size?: string;
    resolution_name?: string;
    image_urls?: string[];
};

export type DuomiImageRequest = {
    model: string;
    prompt: string;
    size?: string;
    quality?: string;
    image?: string[];
};

export type DuomiCreatedTask = { id?: unknown };

export type DuomiMedia = { url?: unknown; file_name?: unknown };

export type DuomiTask = {
    id?: unknown;
    state?: unknown;
    data?: { images?: unknown; videos?: unknown; description?: unknown } | null;
    progress?: unknown;
    message?: unknown;
};

export type DuomiVideoRequest = {
    model: string;
    prompt: string;
    aspect_ratio: string;
    duration: number;
    image_urls?: string[];
    generation_type?: "TEXT" | "FIRST&LAST" | "REFERENCE";
    quality: string;
};

export type AdapterErrorBody = {
    error: {
        message: string;
        type: string;
        status?: number;
    };
};
