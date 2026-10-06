import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { Element, Root } from "hast";
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
		expect(redactDataUris(result.value)).toMatchSnapshot();
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
				// Rasterizing reads the system fonts for every diagram, about a
				// second each, which a fixture with several diagrams pushes past
				// bun's five second default.
				test("renders to inline-png (markdown)", {
					timeout: 30_000,
				}, async () => {
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
				// See the note on the markdown case above.
				test("renders to inline-png (html)", {
					timeout: 30_000,
				}, async () => {
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

/**
 * Replace every data URI with a note of what kind it was.
 *
 * A diagram written into a document as a data URI is one long blob, several
 * hundred kilobytes of base64 for a diagram with fonts in it, and a snapshot
 * that is one long blob is not one anybody reads. The kind is kept, since that
 * is the part a test is looking at.
 */
function redactDataUris(html: string) {
	return html.replace(
		/data:image\/([\w+.-]+)[^"]*/g,
		(_match, kind: string) => `data:image/${kind};[data]`,
	);
}

/** What a base64 data URI carries, as text. */
function decodeDataUri(uri: string) {
	return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").toString(
		"utf8",
	);
}

/**
 * The first element carrying a tag name, depth first.
 *
 * `rehype` parses a fragment into a whole document (`html > head + body`), so
 * what a test is after is never at the top of the tree.
 */
function findElement(root: Root, tagName: string): Element {
	const search = (element: Element): Element | undefined => {
		if (element.tagName === tagName) return element;
		for (const child of element.children) {
			if (child.type !== "element") continue;
			const found = search(child);
			if (found) return found;
		}
	};
	const found = search(root.children[0] as Element);
	if (!found) throw new Error(`no <${tagName}> in the rendered tree`);
	return found;
}

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
		findElement(tree, "pre").properties.className =
			"language-d2 shiki github-dark";
		const rendered = await processor.run(tree);

		expect(redactDataUris(processor.stringify(rendered))).toMatchSnapshot();
		// The diagram is not in the tree at all: it is a data URI in the `src` of
		// an `img`, so no renderer in between ever sees an SVG attribute name to
		// mangle (`markerEnd` for `marker-end`) and nothing is lost on the way to
		// the page.
		const { properties } = findElement(rendered, "img");
		const svg = decodeDataUri(String(properties.src));

		expect(String(properties.src)).toStartWith("data:image/svg+xml;base64,");
		// The worth of the indirection is that the browser gets the diagram D2
		// drew, so the payload has to be one: a readable SVG with its `xmlns`
		// (which an `img` needs and an inline element did not), and the attributes
		// in the case sensitive spelling SVG defines.
		expect(svg).toStartWith("<svg");
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain("marker-end");
		expect(svg).not.toContain("markerEnd");
		// The block carries no title or alt, and the source is not a description:
		// the diagram gets neither rather than a tooltip full of diagram code.
		expect(properties.alt).toBe("");
		expect(Object.keys(properties)).not.toContain("title");
		expect(Object.keys(properties)).not.toContain("aria-label");

		// D2 hands over a `viewBox` and no dimensions, and an SVG without them has
		// no intrinsic size — it would be stretched to the full width of the column
		// however small the diagram is. The size it was drawn at is read back out
		// of the `viewBox`, and `max-width` is what keeps a diagram wider than the
		// column from running past it.
		const [, , drawnWidth, drawnHeight] = String(
			/viewBox="([^"]*)"/.exec(svg)?.[1],
		)
			.split(" ")
			.map(Number);
		expect(properties.width).toBe(drawnWidth);
		expect(properties.height).toBe(drawnHeight);
		expect(properties.style).toBe("max-width:100%;height:auto");
	}, 30_000);

	test("gives an image the size of the diagram it holds", async () => {
		// The same holds for `inline-png`: an SVG in a data URI whose root carries
		// only a `viewBox` gives the `img` no size to fall back on either.
		const processor = rehype().use(rehypeD2, { strategy: "inline-png" });
		const rendered = await processor.run(
			processor.parse(
				await Bun.file("tests/fixtures/nuxt-content.html").text(),
			),
		);
		const { properties } = findElement(rendered, "img");

		expect(properties.width).toBeGreaterThan(0);
		expect(properties.height).toBeGreaterThan(0);
		expect(properties.style).toBe("max-width:100%;height:auto");
		// The strategy is named for what it puts in the `src`, and what it puts
		// there is a raster: a PNG begins with a fixed signature, which base64
		// spells as this.
		expect(String(properties.src)).toStartWith(
			"data:image/png;base64,iVBORw0KGgo",
		);
	}, 30_000);

	/**
	 * The Nuxt Content fixture, annotated the way a fence is.
	 *
	 * `@nuxtjs/mdc` keeps what a fence was written with — `alt="…"` and friends —
	 * in a `meta` property on the `pre` wrapping the block, and gives the `code`
	 * inside it no attributes at all.
	 */
	async function renderAnnotated(options: RehypeD2Options) {
		const processor = rehype().use(rehypeD2, options);
		const tree = processor.parse(
			await Bun.file("tests/fixtures/nuxt-content.html").text(),
		);
		findElement(tree, "pre").properties.meta =
			'alt="A diagram of a message" title="Message passing"';
		return processor.run(tree);
	}

	test("reads the annotations a Nuxt Content block carries", async () => {
		const rendered = await renderAnnotated({ strategy: "inline-png" });
		const { properties } = findElement(rendered, "img");

		expect(properties.alt).toBe("A diagram of a message");
		expect(properties.title).toBe("Message passing");
	}, 30_000);

	test("names a diagram after the annotations a Nuxt Content block carries", async () => {
		const rendered = await renderAnnotated({ strategy: "inline-svg" });
		const { properties } = findElement(rendered, "img");

		// The description is the `alt` of an `img`, not an `aria-label` on an
		// `svg`: the diagram is an image, and this is how an image is named.
		expect(properties.alt).toBe("A diagram of a message");
		expect(properties.title).toBe("Message passing");
		expect(properties["aria-label"]).toBeUndefined();
	}, 30_000);

	test("rasterizes a denser png without changing the size it is drawn at", async () => {
		// `pngScale` is for the display the diagram is read on, not for the page
		// it is written into: a denser raster is sharper, and the element keeps
		// the drawn size so it takes up the same room either way.
		const render = async (pngScale: number) => {
			const processor = rehype().use(rehypeD2, {
				strategy: "inline-png",
				defaultMetadata: { default: { pngScale } },
			});
			const rendered = await processor.run(
				processor.parse('<code class="language-d2">a -> b</code>'),
			);
			return findElement(rendered, "img").properties;
		};
		const single = await render(1);
		const double = await render(2);

		expect(double.width).toBe(single.width);
		expect(double.height).toBe(single.height);
		expect(String(double.src).length).toBeGreaterThan(
			String(single.src).length,
		);
	}, 30_000);
});
