export const duomiVideoRatioOptions = [
    { value: "16:9", label: "横屏", width: 16, height: 9 },
    { value: "9:16", label: "竖屏", width: 9, height: 16 },
] as const;

export function isDuomiVideoModel(model: string) {
    return isVeoVideoModel(model) || isGrokVideoModel(model) || isKlingVideoModel(model);
}

export function isVeoVideoModel(model: string) {
    return /^veo_?3\.1-/i.test(model.trim());
}

export function isGrokVideoModel(model: string) {
    return /^grok-video(?:-1\.5)?$/i.test(model.trim());
}

export function isKlingVideoModel(model: string) {
    return isKlingMultiImageVideoModel(model) || isKlingOmniVideoModel(model);
}

export function isKlingMultiImageVideoModel(model: string) {
    return /^kling-v1-6$/i.test(model.trim());
}

export function isKlingOmniVideoModel(model: string) {
    return /^kling-v3-omni$/i.test(model.trim());
}

export function duomiVideoResolutionOptions(model: string) {
    if (isVeoVideoModel(model)) {
        return [
              { value: "720p", label: "720p" },
              { value: "1080p", label: "1080p" },
              { value: "4k", label: "4K" },
        ];
    }
    return [{ value: "720p", label: isKlingVideoModel(model) ? "标准" : "720p" }];
}

export function duomiVideoSecondOptions(model: string) {
    if (isVeoVideoModel(model)) return [8];
    if (isKlingMultiImageVideoModel(model)) return [5, 10];
    return isKlingOmniVideoModel(model) ? [3, 4, 5, 6, 7, 8, 9, 10] : [6, 10, 15];
}

export function normalizeDuomiVideoResolution(model: string, value: string) {
    const normalized = value.trim().toLowerCase().replace(/^4kp$/, "4k");
    const allowed = duomiVideoResolutionOptions(model).map((item) => item.value);
    return allowed.includes(normalized) ? normalized : "720p";
}

export function normalizeDuomiVideoSeconds(model: string, value: string) {
    const seconds = Math.floor(Number(value));
    const allowed = duomiVideoSecondOptions(model);
    return String(allowed.includes(seconds) ? seconds : allowed[0]);
}

export function normalizeDuomiVideoRatio(value: string) {
    return ["9:16", "720x1280", "1024x1792"].includes(value.trim()) ? "9:16" : "16:9";
}
