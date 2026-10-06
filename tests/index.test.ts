import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { Element } from "hast";
import { rehype } from "rehype";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";
import rehypeD2, { type RehypeD2Options } from "../src/index.ts";

describe("types", () => {
	test("fails if strategy is invalid", () => {
		// @ts-expect-error: we are testing invalid values
		const processor = rehype().use(rehypeD2, { strategy: "invalid" });

		expect(() => processor.processSync("")).toThrowErrorMatchingSnapshot();
	});
	test("fails if cwd is not provided when using imports", () => {
		const processor = rehype().use(rehypeD2, {
			strategy: "inline-svg",
		});

		const vFile = new VFile({
			path: "test.html",
			value: '<code class="language-d2">\n...@vars\n</code>',
		});

		expect(
			async () => await processor.process(vFile),
		).toThrowErrorMatchingSnapshot();
	});

	test("fails if using globalImports without cwd", () => {
		const processor = rehype().use(rehypeD2, {
			strategy: "inline-svg",
			globalImports: {
				b: ["vars.d2"],
			},
		});

		const vFile = new VFile({
			path: "test.html",
			value: '<code class="language-d2">\n...@vars\n</code>',
		});

		expect(
			async () => await processor.process(vFile),
		).toThrowErrorMatchingSnapshot();
	});

	test("fails if using globalImports with a file that doesn't exist", () => {
		const processor = rehype().use(rehypeD2, {
			strategy: "inline-svg",
			cwd: "tests/imports",
			globalImports: {
				a: ["vars.d2", "invalid.d2"],
			},
		});

		const vFile = new VFile({
			path: "test.html",
			value: '<code class="language-d2">\n...@vars\n</code>',
		});

		expect(
			async () => await processor.process(vFile),
		).toThrowErrorMatchingSnapshot();
	});
});

describe("renders", async () => {
	const fixtures = readdirSync("tests/fixtures");

	const options: RehypeD2Options = {
		cwd: "tests/imports",
		defaultMetadata: {
			dark: {
				themeID: 200,
			},
		},
		globalImports: {
			dark: [
				{
					filename: "global.d2",
					mode: "prepend",
				},
			],
		},
	} as const;

	const runTest = async ({
		processor,
		outputFileName,
		fixtureContent,
	}: {
		processor: any;
		outputFileName: string;
		fixtureContent: string;
	}) => {
		const result = await processor.process(fixtureContent);
		expect(result.value).toMatchSnapshot();
		if (process.env.CI !== "true") {
			Bun.write(`tests/output/${outputFileName}`, result.value);
		}
	};

	for (const fixture of fixtures) {
		const fixtureContent = await Bun.file(`tests/fixtures/${fixture}`).text();
		if (fixture.endsWith(".md")) {
			describe(fixture, () => {
				test("renders to inline-svg (markdown)", async () => {
					const processor = unified()
						.use(remarkParse)
						.use(remarkRehype)
						.use(rehypeD2, {
							...options,
							strategy: "inline-svg",
						})
						.use(rehypeStringify);
					await runTest({
						processor,
						outputFileName: `${fixture}-inline-svg.html`,
						fixtureContent,
					});
				});
				test("renders to inline-png (markdown)", async () => {
					const processor = unified()
						.use(remarkParse)
						.use(remarkRehype)
						.use(rehypeD2, {
							...options,
							strategy: "inline-png",
						})
						.use(rehypeStringify);
					await runTest({
						processor,
						outputFileName: `${fixture}-inline-png.html`,
						fixtureContent,
					});
				});
			});
		} else {
			describe(fixture, () => {
				test("renders to inline-svg (html)", async () => {
					const processor = rehype().use(rehypeD2, {
						...options,
						strategy: "inline-svg",
					});
					await runTest({
						processor,
						outputFileName: `${fixture}-inline-svg.html`,
						fixtureContent,
					});
				});
				test("renders to inline-png (html)", async () => {
					const processor = rehype().use(rehypeD2, {
						...options,
						strategy: "inline-png",
					});
					await runTest({
						processor,
						outputFileName: `${fixture}-inline-png.html`,
						fixtureContent,
					});
				});
			});
		}
	}
});

describe("nuxt content", () => {
	// `@nuxtjs/mdc`, the renderer behind Nuxt Content, moves the language marker
	// onto the `pre` wrapping a code block; `tests/fixtures/nuxt-content.html` is
	// that shape. Its syntax highlighter then rewrites the `class` attribute from
	// a list into a single string, which is applied on top of the fixture here.
	// The render sits close to the default 5s timeout when the whole suite runs.
	test("renders a block whose class was rewritten by a highlighter", async () => {
		const processor = rehype().use(rehypeD2, { strategy: "inline-svg" });
		const tree = processor.parse(
			await Bun.file("tests/fixtures/nuxt-content.html").text(),
		);
		const pre = tree.children[0] as {
			properties: { className: string | string[] };
		};
		pre.properties.className = "language-d2 shiki github-dark";
		const rendered = await processor.run(tree);

		expect(processor.stringify(rendered)).toMatchSnapshot();
		// The same renderer hands property names to the DOM as attributes, and SVG
		// is case sensitive: `markerEnd` is a name it ignores where the arrowhead is
		// defined by `marker-end`. `viewBox`, camelCase in SVG itself, stays as is.
		const names = new Set<string>();
		const collect = (element: Element) => {
			for (const name of Object.keys(element.properties ?? {})) names.add(name);
			for (const child of element.children) {
				if (child.type === "element") collect(child);
			}
		};
		collect(rendered.children[0] as Element);

		expect([...names]).toContain("marker-end");
		expect([...names]).toContain("stroke-width");
		expect([...names]).toContain("viewBox");
		expect([...names]).not.toContain("markerEnd");
		// The block carries no title or alt, and the source is not a description:
		// the diagram gets neither rather than a tooltip full of diagram code.
		expect([...names]).toContain("role");
		expect([...names]).not.toContain("title");
		expect([...names]).not.toContain("aria-label");
	}, 30_000);
});
