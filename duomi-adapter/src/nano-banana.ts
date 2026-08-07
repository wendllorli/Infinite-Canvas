export const NANO_BANANA_MODELS = ["gemini-3-pro-image-preview", "gemini-2.5-flash-image", "gemini-3.1-flash-image-preview"] as const;

export function isNanoBananaModel(model: string) {
    return (NANO_BANANA_MODELS as readonly string[]).includes(model.trim());
}

export function nanoBananaImageSize(value: string | undefined) {
    const size = value?.trim().toUpperCase();
    return size === "1K" || size === "2K" || size === "4K" ? size : undefined;
}
