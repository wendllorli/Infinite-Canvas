import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";

type DuomiConfig = Pick<AiConfig, "baseUrl">;
type UploadResponse = { url?: string; error?: { message?: string } };

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function isDuomiAdapterBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl, window.location.origin);
        return /\/api\/duomi\/v1\/?$/i.test(url.pathname);
    } catch {
        return /\/api\/duomi\/v1\/?$/i.test(baseUrl.trim());
    }
}

export async function uploadDuomiImages(config: DuomiConfig, files: File[], signal?: AbortSignal) {
    const urls: string[] = [];
    for (const file of files) {
        if (!IMAGE_TYPES.has(file.type)) throw new Error(`不支持的参考图格式：${file.type || file.name}`);
        if (file.size > MAX_IMAGE_BYTES) throw new Error(`参考图 ${file.name} 超过 20 MB 限制`);
        const response = await axios.post<UploadResponse>(buildApiUrl(config.baseUrl, "/uploads"), file, {
            headers: { "Content-Type": file.type },
            signal,
        });
        if (!response.data.url) throw new Error(response.data.error?.message || "参考图上传后没有返回公网 URL");
        urls.push(response.data.url);
    }
    return urls;
}
