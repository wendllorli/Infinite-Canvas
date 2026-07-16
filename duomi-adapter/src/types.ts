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

export type DuomiCreatedTask = {
    id?: unknown;
    task_id?: unknown;
    code?: unknown;
    message?: unknown;
    msg?: unknown;
    data?: { id?: unknown; task_id?: unknown } | null;
};

export type DuomiMedia = { url?: unknown; file_name?: unknown };

export type DuomiTask = {
    id?: unknown;
    state?: unknown;
    data?: { images?: unknown; videos?: unknown; description?: unknown } | null;
    progress?: unknown;
    message?: unknown;
};

export type DuomiStandardVideoRequest = {
    model: string;
    prompt: string;
    aspect_ratio: string;
    duration: number;
    image_urls?: string[];
    generation_type?: "TEXT" | "FIRST&LAST" | "REFERENCE";
    quality: string;
};

export type DuomiKlingVideoRequest = {
    model_name: string;
    image_list: Array<{ image: string }>;
    prompt: string;
    negative_prompt: string;
    mode: "std";
    duration: string;
    aspect_ratio: "16:9" | "9:16";
};

export type DuomiVideoRequest = DuomiStandardVideoRequest | DuomiKlingVideoRequest;

export type DuomiKlingTask = {
    code?: unknown;
    message?: unknown;
    msg?: unknown;
    data?: {
        task_id?: unknown;
        task_status?: unknown;
        task_status_msg?: unknown;
        task_result?: { videos?: unknown; images?: unknown } | null;
    } | null;
};

export type DuomiVideoTaskResult =
    | { provider: "standard"; task: DuomiTask }
    | { provider: "kling"; task: DuomiKlingTask };

export type AdapterErrorBody = {
    error: {
        message: string;
        type: string;
        status?: number;
    };
};
