// Ambient declarations for esbuild-resolved imports that TypeScript can't see.

declare module "@cornerstonejs/codec-openjpeg/decode" {
	// Emscripten MODULARIZE factory; returns the module instance (with J2KDecoder).
	const factory: (moduleArg?: Record<string, unknown>) => Promise<any>;
	export default factory;
}

// The ".wasm" file is imported with esbuild's "binary" loader => Uint8Array.
declare module "@cornerstonejs/codec-openjpeg/decodewasm" {
	const data: Uint8Array;
	export default data;
}
