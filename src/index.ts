import { readdirSync, readFileSync } from "node:fs";
import { type CompileOptions, D2 } from "@d2lang/d2";
import { Resvg } from "@resvg/resvg-js";
import type { Element, Properties, Root } from "hast";
import { optimize, type Config as SvgoConfig } from "svgo";
import type { Plugin } from "unified";
import { visitParents } from "unist-util-visit-parents";

const strategies = ["inline-svg", "inline-png"] as const;
type Strategy = (typeof strategies)[number];

const svggoConfig: SvgoConfig = {};

interface FoundNode {
	/** The element holding the diagram source, replaced in the tree. */
	node: Element;
	/** Its parent, the element the source is spliced out of. */
	ancestor: Element;
	value: string;
}

function isValidStrategy(strategy: string): strategy is Strategy {
	return strategies.includes(strategy as Strategy);
}

function validateImports(options: RehypeD2Options, fs: Record<string, string>) {
	const { globalImports } = options;
	if (!globalImports) return;

	for (const [theme, imports] of Object.entries(globalImports)) {
		if (imports.length === 0) return;
		const invalidImports = imports.filter((importName) => {
			if (typeof importName === "string") return fs[importName] === undefined;
			return fs[importName.filename] === undefined;
		});
		if (invalidImports.length > 0) {
			const fsKeys = Object.keys(fs).toSorted();
			throw new RehypeD2RendererError(
				`Invalid imports: ${invalidImports.join(", ")} for theme ${theme}, found files: [${fsKeys.join(", ")}]`,
			);
		}
	}
}

function optimizeSvg(svg: string, config: SvgoConfig) {
	const { data } = optimize(svg, config);
	return data;
}

/**
 * Read the size a diagram was drawn at from its `viewBox`.
 *
 * D2 gives the `<svg>` it renders a `viewBox` and nothing else, and an SVG
 * without `width`/`height` has no intrinsic size: a renderer stretches it to
 * the width of whatever holds it, so a small diagram is blown up to fill the
 * column and a wide one runs past it. The `viewBox` is the only record of the
 * size the diagram was drawn at.
 */
function viewBoxSize(svg: string) {
	const matched = /viewBox=["']([^"']*)["']/.exec(svg)?.[1];
	const [, , width, height] =
		matched
			?.trim()
			.split(/[\s,]+/)
			.map(Number) ?? [];
	if (!Number.isFinite(width) || !Number.isFinite(height)) return {};
	return { width, height };
}

/**
 * Rasterize an SVG into a PNG data URI.
 *
 * The name `inline-png` is the one `rehype-mermaid` uses, and there the
 * rasterizing is done by a browser it drives; there is no browser here, so the
 * raster has to be produced from the SVG some other way. `@resvg/resvg-js` does
 * it in process — no browser, no network — and the fonts come along: D2 writes
 * the ones a diagram uses into the SVG as embedded `@font-face` data.
 *
 * The raster is made at the size the diagram was drawn at, and `pngScale` is
 * for the display the diagram will be read on rather than the page it is
 * written into: a raster of a diagram is mostly text, which looks soft at 1x on
 * anything but a 1x screen. The element keeps the drawn size in its `width` and
 * `height` either way, so asking for a denser raster sharpens the diagram
 * without changing how much room it takes up.
 */
function svgToPngDataUri(svg: string, scale: number) {
	const resvg = new Resvg(svg, {
		fitTo:
			scale === 1
				? // The SVG is drawn at one size and has no other; `original` is
					// that size rather than a guess at a width to fit.
					{ mode: "original" }
				: { mode: "zoom", value: scale },
	});
	const png = resvg.render().asPng();
	return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * Put an SVG in a data URI an `img` can hold.
 *
 * The diagram goes into the `src` of an `img` rather than into the tree as an
 * `svg` element. An element in the tree is at the mercy of whatever renders it:
 * `@nuxtjs/mdc` hands the properties of every element to the DOM as attributes,
 * and its HTML schema does not know that hast's `markerEnd` stands for
 * `marker-end`, so the arrowheads and text styling of an inline SVG were lost on
 * the way to the page. A data URI is opaque to it — nothing between here and the
 * browser parses the diagram, and the browser parses it as the SVG it is.
 *
 * It is spelled out in base64 rather than percent encoded: base64 has no
 * character that means anything in a URI, where the SVG is full of them — XML,
 * quotes, the `#` of the colors and font data D2 embeds.
 *
 * Being an SVG document, it is also drawn with the fonts inside it, which are
 * the ones D2 chose; the `inline-png` raster cannot use them (see
 * `svgToPngDataUri`) and falls back to the system's.
 */
function svgToDataUri(svg: string) {
	const base64 = Buffer.from(svg, "utf8").toString("base64");
	return `data:image/svg+xml;base64,${base64}`;
}

type D2Target = NonNullable<RehypeD2Options["target"]>;

/**
 * Split a hast `className` property into its tokens.
 *
 * It is an array when it comes straight from `remark-rehype`, but a single
 * space separated string once a syntax highlighter has rewritten it, which is
 * what `@nuxtjs/mdc` does to the `pre` of every code block it highlights.
 */
function classNameTokens(className: unknown) {
	if (Array.isArray(className)) return className.map(String);
	if (typeof className === "string") return className.split(/\s+/);
	return [];
}

/** Whether a node carries the configured language marker. */
function hasD2Marker(node: Element, target: D2Target) {
	return classNameTokens(node.properties?.className).includes(target.className);
}

function isD2Tag(node: Element, target: D2Target) {
	return node.tagName === target.tagName && hasD2Marker(node, target);
}

/** The `code` element a `pre` wraps, when that `pre` holds nothing else. */
function codeChildOf(node: Element) {
	if (node.tagName !== "pre" || node.children.length !== 1) return undefined;
	const child = node.children[0];
	if (child?.type === "element" && child.tagName === "code") return child;
}

/**
 * Locate the element holding a D2 block's source, and its parent.
 *
 * Pipelines disagree about where the language marker goes:
 *
 * - `remark-rehype` tags the `code` element itself:
 *     `<pre><code class="language-d2">source</code></pre>`
 * - `@nuxtjs/mdc` (the renderer behind Nuxt Content) tags the `pre` wrapping it
 *   and leaves the inner `code` without any class at all:
 *     `<pre language="d2" class="language-d2"><code>source</code></pre>`
 * - a `target` pointed at `pre` matches the wrapper rather than the `code`.
 *
 * The source always ends up in a `code` element, so a match on the wrapper is
 * resolved one level down to it. That also keeps the annotations
 * `@nuxtjs/mdc` stores on the `code` (a fenced block's `title="..."` and
 * friends) readable, since `parseMetadata` looks at the matched node.
 */
function resolveD2Source(
	node: Element,
	parent: Element | undefined,
	target: D2Target,
): { node: Element; ancestor: Element } | undefined {
	if (isD2Tag(node, target)) {
		const code = codeChildOf(node);
		// biome-ignore lint/style/noNonNullAssertion: an element is never the root
		return code ? { node: code, ancestor: node } : { node, ancestor: parent! };
	}
	// The `@nuxtjs/mdc` shape: the marker sits on the `pre`, the `code` it wraps
	// is the one carrying the source.
	if (
		node.tagName === "code" &&
		parent?.tagName === "pre" &&
		hasD2Marker(parent, target)
	) {
		return { node, ancestor: parent };
	}
}

function valueContainsImports(value: string) {
	// Imports are defined using the ...@filename syntax
	const pattern = /^\s*...@\w+(?:\.d2)?\s*$/gm;
	return pattern.test(value);
}

function buildImportDirectory(cwd: string | undefined) {
	if (!cwd) return {};
	const imports = readdirSync(cwd);
	return imports.reduce(
		(acc, importName) => {
			if (!importName.endsWith(".d2")) return acc;
			const importPath = `${cwd}/${importName}`;
			const importContent = readFileSync(importPath, "utf-8");
			acc[importName] = importContent;
			return acc;
		},
		{} as Record<string, string>,
	);
}

function buildHeaders(
	options: RehypeD2Options,
	theme: string,
	fs: Record<string, string>,
) {
	if (!options.globalImports) return "";
	if (!options.globalImports[theme]) return "";
	const r = options.globalImports[theme]
		.map((importName) => {
			if (typeof importName === "string") {
				const withoutSuffix = importName.replace(/\.d2$/, "");
				return `...@${withoutSuffix}`;
			}
			if (importName.mode === "import") {
				const withoutSuffix = importName.filename.replace(/\.d2$/, "");
				return `...@${withoutSuffix}`;
			}
			return fs[importName.filename];
		})
		.filter(Boolean)
		.join("\n");
	return `${r}\n`;
}

function autoCastValue(value: unknown) {
	const valueAsNumber = Number(value);
	if (!Number.isNaN(valueAsNumber)) {
		return valueAsNumber;
	}
	if (value === "true" || value === "false") {
		return value === "true";
	}
	return value;
}

/**
 * Read the annotations a block was given, e.g. `title="Diagram title"`.
 *
 * A pipeline hands the attribute string over in one of two ways, and both are
 * read:
 *
 * - `remark-rehype` keeps it on the `code` element it makes the source into, as
 *   `data.meta`:
 *     `<code class="language-d2" data.meta="title=&quot;…&quot;">`
 * - `@nuxtjs/mdc`, the renderer behind Nuxt Content, keeps it in a `meta`
 *   property on the `pre` wrapping the block, next to the `language` marker,
 *   and gives the `code` inside it no attributes at all:
 *     `<pre language="d2" class="language-d2" meta="title=&quot;…&quot;">`
 */
function parseMetadata(node: Element, block?: Element) {
	// `title` and `alt` are deliberately absent: they are the diagram's
	// accessible name and its tooltip, and the only thing this plugin could fall
	// back to is the diagram's source, which belongs in neither.
	const metadata: Record<string, unknown> = {
		noXMLTag: true,
		center: true,
		pad: 0,
		optimize: true,
	};

	const data = node.data as unknown as { meta?: string };
	const annotations = [data?.meta, block?.properties?.meta].filter(
		(meta): meta is string => typeof meta === "string" && meta.length > 0,
	);
	for (const annotation of annotations) {
		// The syntax is `key="value"` (note the quotes), e.g.
		// `width="200" title="Diagram title"`, and a value that needs no quotes
		// is read without them.
		const pattern = /([^=\s]+)=(?:"([^"]*)"|([^\s]*))/g;
		let match: RegExpMatchArray | null;
		while (true) {
			match = pattern.exec(annotation);
			if (!match) break;
			const key = match[1];
			const value = match[2] !== undefined ? match[2] : match[3];
			if (!key || !value) continue;
			metadata[key] = autoCastValue(value);
		}
	}

	if (node.properties) {
		for (const [key, value] of Object.entries(node.properties)) {
			if (Array.isArray(value)) continue;
			metadata[key] = autoCastValue(value);
		}
	}

	// themes is a special case, we expect an array
	if (!Array.isArray(metadata.themes) && typeof metadata.themes === "string") {
		metadata.themes = metadata.themes.split(",");
	}

	return metadata;
}

function addDefaultMetadata(
	to: Record<string, unknown>,
	value: string,
	theme: string,
	defaultMetadata: RehypeD2Options["defaultMetadata"],
) {
	if (!defaultMetadata?.[theme]) return;
	for (const [key, defaultValue] of Object.entries(defaultMetadata[theme])) {
		if (to[key]) continue;
		if (typeof defaultValue === "function") {
			to[key] = defaultValue(value);
		} else {
			to[key] = defaultValue;
		}
	}
}

type Themes = readonly [string, ...string[]];

export type RehypeD2Options<T extends Themes = Themes> = {
	/**
	 * What the diagram is inlined as. Either way it is written into an `img`,
	 * as a data URI in its `src`.
	 *
	 * - `"inline-svg"` (the default) writes the SVG D2 rendered, base64 encoded:
	 *   vector, and drawn with the fonts embedded in the diagram.
	 * - `"inline-png"` rasterizes that SVG with `@resvg/resvg-js` instead, at
	 *   `pngScale` pixels per pixel of the drawn size. The raster cannot use the
	 *   embedded fonts and is drawn with the system's.
	 */
	strategy?: Strategy;
	cwd?: string;
	target?: {
		tagName: string;
		className: string;
	};
	defaultThemes?: T;
	defaultMetadata?: Record<
		T[number],
		{
			[k in keyof NodeMetadata]?:
				| NodeMetadata[k]
				| ((value: string) => NodeMetadata[k]);
		}
	>;
	globalImports?: Record<
		T[number],
		Array<
			| `${string}.d2`
			| {
					filename: `${string}.d2`;
					mode: "prepend" | "import";
			  }
		>
	>;
	/**
	 * The tag to give the container a diagram is rendered into when it replaces
	 * the content of a `pre` code block. Defaults to `"p"`.
	 *
	 * Leaving the `pre` in place is not safe: `@nuxtjs/mdc`'s syntax highlighter
	 * rewrites any `pre` carrying a `language` property, and since the diagram
	 * is no longer a `code` element it replaces the whole block — SVG included —
	 * with highlighted text.
	 */
	containerTagName?: string;
	/** The properties to give that container. Defaults to `{}`. */
	containerTagProps?: Properties;
};

export interface NodeMetadata
	extends Omit<CompileOptions, `font${string}` | "target" | "darkThemeId"> {
	title?: string;
	alt?: string;
	width?: string;
	height?: string;
	optimize?: boolean;
	/**
	 * How many raster pixels the `inline-png` strategy gets per pixel of the
	 * diagram's own size. Defaults to `1`; `2` keeps a diagram sharp on a
	 * display that draws two pixels per CSS pixel. The strategy is the only one
	 * with a raster to sharpen.
	 */
	pngScale?: number;
}

export class RehypeD2RendererError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RehypeD2RendererError";
	}
}

const rehypeD2: Plugin<[RehypeD2Options], Root> = (
	options: RehypeD2Options,
) => {
	const {
		strategy = "inline-svg",
		target = {
			tagName: "code",
			className: "language-d2",
		},
		cwd,
		defaultMetadata,
		globalImports,
		defaultThemes = ["default"],
		containerTagName = "p",
		containerTagProps = {},
	} = options;

	if (!isValidStrategy(strategy)) {
		throw new RehypeD2RendererError(
			`Invalid strategy "${strategy}". Valid strategies are: ${strategies.join(
				", ",
			)}`,
		);
	}
	if (
		globalImports &&
		Object.values(globalImports).some((imports) => imports.length > 0) &&
		!cwd
	) {
		throw new RehypeD2RendererError(
			`To use globalImports, you must provide a "cwd" option (directory to resolve imports from)`,
		);
	}

	const fs = buildImportDirectory(cwd);
	validateImports(options, fs);

	return async (tree) => {
		const foundNodes: FoundNode[] = [];

		visitParents(tree, "element", (node, ancestors) => {
			const parent = ancestors.at(-1) as Element | undefined;
			const source = resolveD2Source(node, parent, target);
			if (!source || source.node.children.length === 0) {
				return;
			}
			if (source.node.children.length !== 1) {
				throw new RehypeD2RendererError(
					`Expected exactly one child element for ${source.node.tagName} elements, but found ${source.node.children.length}`,
				);
			}

			const nodeContent = source.node.children[0] as { value: string };

			if (valueContainsImports(nodeContent.value) && !cwd) {
				throw new RehypeD2RendererError(
					`To use imports, you must provide a "cwd" option (directory to resolve imports from)`,
				);
			}

			foundNodes.push({
				node: source.node,
				value: nodeContent.value,
				ancestor: source.ancestor,
			});
		});

		await Promise.all(
			foundNodes.map(async ({ node, value, ancestor }) => {
				const d2 = new D2();
				try {
					const baseMetadata = parseMetadata(node, ancestor);
					if (!baseMetadata.themes) {
						baseMetadata.themes = defaultThemes;
						if (defaultThemes.length === 0) {
							throw new RehypeD2RendererError(
								"Missing themes in metadata and no defaultThemes found",
							);
						}
					}

					const metadataThemes = new Set(baseMetadata.themes as string[]);
					const elements: Element[] = [];

					for (const theme of metadataThemes) {
						const headers = buildHeaders(options, theme, fs);
						const metadata = JSON.parse(JSON.stringify(baseMetadata));
						addDefaultMetadata(metadata, value, theme, defaultMetadata);

						// Add theme to metadata salt so the diagram ID is unique
						metadata.salt = theme;

						const codeToProcess = `${headers}${value}`;
						const render = await d2.compile({
							fs: {
								...fs,
								index: codeToProcess,
							},
							options: metadata,
						});

						const svg = await d2.render(render.diagram, render.renderOptions);
						if (typeof svg !== "string") {
							throw new RehypeD2RendererError(
								`Failed to render svg diagram for ${value}`,
							);
						}
						let optimizedSvg: string = svg;
						if (metadata.optimize) {
							optimizedSvg = optimizeSvg(svg, svggoConfig);
						}

						const drawn = viewBoxSize(optimizedSvg);
						const sharedProperties: Properties = {
							height: (metadata.height as number) ?? drawn.height,
							width: (metadata.width as number) ?? drawn.width,
							// A diagram is shown at the size it was drawn at, and the cap
							// keeps one wider than the column it sits in from running past
							// it. `height: auto` lets it shrink at its own ratio; an
							// explicit height is a shape the author asked for and is left
							// alone.
							style: metadata.height
								? "max-width:100%"
								: "max-width:100%;height:auto",
							"data-d2-theme": theme,
						};
						if (metadata.title) {
							sharedProperties.title = metadata.title as string;
						}

						// The strategies differ in what the `src` holds, not in the
						// shape of what is written into the document: an `img`, with the
						// diagram in it as a data URI — vector for one, raster for the
						// other — and the size of the diagram drawn on the element.
						const img: Element = {
							type: "element",
							tagName: "img",
							properties: {
								...sharedProperties,
								// An `img` has to carry an `alt`; with no description it
								// is exposed as decorative rather than as its own source.
								alt: (metadata.alt as string | undefined) ?? "",
								src:
									strategy === "inline-svg"
										? svgToDataUri(optimizedSvg)
										: // The density of the raster (see
											// `svgToPngDataUri`). The element's own size is the
											// drawn size whatever this is, so raising it
											// sharpens the diagram rather than enlarging it.
											svgToPngDataUri(
												optimizedSvg,
												(metadata.pngScale as number | undefined) ?? 1,
											),
							},
							children: [],
						};
						elements.push(img);
					}

					// biome-ignore lint/style/noNonNullAssertion: Element is not the root so it has a parent
					const children = ancestor.children!;
					const index = children.indexOf(node);
					children.splice(index, 1, ...elements);

					// A `pre` left around the diagram is mistaken for a code block by
					// anything running after this plugin: `@nuxtjs/mdc` highlights every
					// `pre` carrying a `language` property and, finding no `code` to write
					// into, replaces the diagram with highlighted text. Retag it, and drop
					// the properties that come with the code block shape (`language`,
					// `code`, the whole fence source) along with it.
					if (ancestor.tagName === "pre") {
						ancestor.tagName = containerTagName;
						ancestor.properties = { ...containerTagProps };
					}
				} finally {
					// `@d2lang/d2` compiles in a worker thread on Node, and that thread
					// holds the process open until it is terminated: a script that
					// renders diagrams and then ends — a build step, say — never exits.
					await d2.dispose();
				}
			}),
		);
	};
};

export default rehypeD2;
