import { AdapterError } from "./errors.js";

export const MAX_RESULT_IMAGE_BYTES = 30 * 1024 * 1024;

export async function fetchDuomiResultImage(value: unknown, fetchImpl: typeof fetch = fetch) {
    let url = resultImageUrl(value);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
        let response: Response;
        try {
            response = await fetchImpl(url, { headers: { Accept: "image/*" }, redirect: "manual" });
        } catch (error) {
            throw new AdapterError(502, error instanceof Error ? `Duomi result image download failed: ${error.message}` : "Duomi result image download failed", "duomi_media_error");
        }
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location || redirect === 3) throw new AdapterError(502, "Duomi result image returned an invalid redirect", "duomi_media_error");
            url = resultImageUrl(new URL(location, url).toString());
            continue;
        }
        if (!response.ok) throw new AdapterError(response.status === 404 ? 404 : 502, `Duomi result image download failed with status ${response.status}`, "duomi_media_error", response.status);
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
        if (!contentType.startsWith("image/")) throw new AdapterError(502, "Duomi result URL did not return an image", "invalid_upstream_response");
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_RESULT_IMAGE_BYTES) throw new AdapterError(502, "Duomi result image exceeds 30 MB", "invalid_upstream_response");
        return response;
    }
    throw new AdapterError(502, "Duomi result image download failed", "duomi_media_error");
}

function resultImageUrl(value: unknown) {
    if (typeof value !== "string" || !value.trim()) throw new AdapterError(400, "Result image URL is required", "invalid_request_error");
    try {
        const url = new URL(value.trim());
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== "https:" || !isDuomiMediaHost(hostname)) throw new Error();
        return url;
    } catch {
        throw new AdapterError(400, "Result image URL host is not allowed", "invalid_request_error");
    }
}

function isDuomiMediaHost(hostname: string) {
    return hostname.endsWith(".dmiapi.com")
        || hostname.endsWith(".duomiapi.com")
        || /^openservice(?:-[a-z0-9]+)*\.oss-cn-[a-z0-9-]+\.aliyuncs\.com$/.test(hostname);
}
