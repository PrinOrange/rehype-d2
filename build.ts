import type { BuildConfig } from "bun";

const defaultBuildConfig: BuildConfig = {
	target: "node",
	entrypoints: ["./src/index.ts"],
	outdir: "./dist",
	packages: "external",
};

await Promise.all([
	Bun.build({
		...defaultBuildConfig,
		format: "esm",
		naming: "[dir]/[name].js",
	}),
	Bun.build({
		...defaultBuildConfig,
		format: "cjs",
		naming: "[dir]/[name].cjs",
	}),
	// TypeScript 7 no longer exposes the compiler API, so the declaration files
	// are emitted by tsc directly instead of bun-plugin-dts.
	Bun.$`tsc -p tsconfig.build.json`,
]);
