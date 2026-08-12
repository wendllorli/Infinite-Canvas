import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
    value: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
    },
});

const { isSeedanceVideoConfig, seedanceModelName } = await import("@/lib/seedance-video");
const { defaultConfig } = await import("@/stores/use-config-store");

describe("Seedance model routing", () => {
    it("uses the node-selected Seedance model instead of the stale global video model", () => {
        const selectedModel = "doubao-seedance::doubao-seedance-2-0-260128";
        const config = {
            ...defaultConfig,
            model: selectedModel,
            videoModel: "default::grok-video",
        };

        expect(seedanceModelName(config, selectedModel)).toBe("doubao-seedance-2-0-260128");
        expect(isSeedanceVideoConfig(config, selectedModel)).toBe(true);
        expect(isSeedanceVideoConfig(config, config.videoModel)).toBe(false);
    });
});
