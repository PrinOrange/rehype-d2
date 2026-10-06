import { readdirSync, readFileSync } from "node:fs";
import { type CompileOptions, D2 } from "@d2lang/d2";
import type { Element, ElementContent, Properties, Root } from "hast";
import { fromHtml } from "hast-util-from-html";
import svgToDataURI from "mini-svg-data-uri";
import { find, svg } from "property-information";
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
 * Rename the properties of an SVG subtree to the attribute names they stand
 * for.
 *
 * hast names attributes in camelCase (`marker-end` is stored as `markerEnd`),
 * which a serializer maps back, but a renderer that forwards those names to the
 * DOM does not: `@nuxtjs/mdc` turns every property into a prop and Vue sets it
 * with `setAttribute`, and since SVG is case sensitive, `markerEnd` is ignored
 * where the renderer looks for `marker-end` — arrowheads disappear, and text
 * loses its font and anchoring.
 *
 * The SVG schema is the only thing that can tell the two flavours of camelCase
 * apart — `fontFamily` stands for `font-family`, while `viewBox` really is
 * `viewBox` — so the name is resolved with `property-information` rather than by
 * hand. Names the schema doesn't know are returned unchanged.
 */
function useSvgAttributeNames(node: Element | Root, insideSvg = false) {
	const inSvg =
		insideSvg || (node.type === "element" && node.tagName === "svg");

	if (node.type === "element" && inSvg && node.properties) {
		node.properties = Object.fromEntries(
			Object.entries(node.properties).map(([name, value]) => [
				find(svg, name).attribute,
				value,
			]),
		);
	}

	for (const child of node.children) {
		if (child.type === "element") useSvgAttributeNames(child, inSvg);
	}
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

function parseMetadata(node: Element) {
	// `title` and `alt` are deliberately absent: they are the diagram's
	// accessible name and its tooltip, and the only thing this plugin could fall
	// back to is the diagram's source, which belongs in neither.
	const metadata: Record<string, unknown> = {
		noXMLTag: true,
		center: true,
		pad: 0,
		optimize: true,
	};

	const data = node.data as unknown as { meta: string };
	if (data?.meta) {
		// When using markdown, metadata are stored in data.meta using the syntax `key="value"`, e.g. `width="200" title="Diagram title"` (note the quotes)
		const pattern = /([^=\s]+)=(?:"([^"]*)"|([^\s]*))/g;
		let match: RegExpMatchArray | null;
		while (true) {
			match = pattern.exec(data.meta);
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
					const baseMetadata = parseMetadata(node);
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

						const sharedProperties: Properties = {
							height: metadata.height as number,
							width: metadata.width as number,
							"data-d2-theme": theme,
						};
						if (metadata.title) {
							sharedProperties.title = metadata.title as string;
						}

						let result: ElementContent;
						if (strategy === "inline-svg") {
							const root = fromHtml(optimizedSvg, {
								fragment: true,
							}) as unknown as Root;
							useSvgAttributeNames(root);
							// biome-ignore lint/style/noNonNullAssertion: There is a root element
							const svgElement = root.children![0] as Element;
							svgElement.properties = {
								...svgElement.properties,
								...sharedProperties,
								role: "img",
							};
							if (metadata.alt) {
								svgElement.properties["aria-label"] = metadata.alt as string;
							}
							result = svgElement;
						} else {
							const img: Element = {
								type: "element",
								tagName: "img",
								properties: {
									...sharedProperties,
									// An `img` has to carry an `alt`; with no description it
									// is exposed as decorative rather than as the source.
									alt: (metadata.alt as string | undefined) ?? "",
									src: svgToDataURI(optimizedSvg),
								},
								children: [],
							};
							result = img;
						}
						elements.push(result);
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
