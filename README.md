# rehype-d2

A [Rehype](https://github.com/rehypejs/rehype) plugin to convert [D2](https://d2lang.com/) diagrams to images — SVG or PNG, inlined as a data URI.

## Installation

```sh
bun install @codemetic/rehype-d2
```

## Usage

```js
import { rehype } from 'rehype'
import rehypeD2 from '@codemetic/rehype-d2'

const processor = await rehype()
  .use(rehypeD2, { strategy: 'inline-svg', cwd: "d2", defaultMetadata: { default: { layout: "elk", sketch: true, pad: 0 } } })
  .process(...)
```

### Options

- `strategy`: The strategy to use for rendering the diagrams. Either way the diagram ends up inlined in the `src` of an `img`, as a data URI.
  - `'inline-svg'`: The SVG D2 rendered, base64 encoded into a `data:image/svg+xml` URI. This is the default. *Recommended*: it is vector, and the diagram is drawn with the fonts embedded in it.
  - `'inline-png'`: The same SVG rasterized with [`@resvg/resvg-js`](https://github.com/thx/resvg-js) into a `data:image/png;base64` URI, in process, at the size the diagram was drawn at. It cannot use the fonts embedded in the SVG and falls back to the system's; `pngScale` makes the raster denser.

- `cwd`: The working directory to use for to resolve imports.
   - If not provided, imports won't be available.

- `containerTagName`: The tag to give the container a diagram is rendered into when it replaces the content of a `pre` code block. Default is `p`.
  - A `pre` left around the diagram is picked up by syntax highlighters running after this plugin, which will highlight the block's text and throw the diagram away. Retagging it avoids that.
  - The tag has to be one that can hold what replaces the block, which is an `img`.

- `containerTagProps`: The properties to give that container. Default is `{}`.

- `defaultThemes`: The themes to use if no themes are specified in the metadata. Default is `["default"]`.

- `defaultMetadata`: The options to pass to the D2 renderer. See [D2 Render Options](https://github.com/d2lang/d2/blob/master/d2js/js/index.d.ts)
  - Dictionary of themes, each theme is a key.

- `globalImports`: A list of imports to add to the D2 renderer. Requires `cwd` to be set.
  - Dictionary of themes, each theme is a key.
  - Example: `{ light: ["light.d2"], dark: ["dark.d2"] }`, will prepend the content diagram with `...@light.d2` and `...@dark.d2` respective to the theme.
  - Sometimes using the import syntax can be limiting, for example if you want a `*` selector to also effect other files. In this case you can use the include syntax: `{ light: [{ filename: "light.d2", mode: "prepend" }], dark: [{ filename: "dark.d2", mode: "prepend" }] }`. When using `prepend` the whole file will be prepended as if it was always a single file. (default value is equivalent to `mode: "impot"`



# Examples

You can pass any props to the code block, this will override the `defaultMetadata` option.

```html
<code class="language-d2" title="This is a diagram" alt="This is a description" width="200" height="100">
...@vars

a: From
b: To
a -> b: Message
</code>
```


When using [remark](https://github.com/remarkjs/remark) to process markdown and transform it into HTML, metadata fields can also be used:

~~~md
```d2 width=200 height=100 title="This is a diagram" alt="This is a description"
...@vars

a: From
b: To
a -> b: Message
```
~~~

This will generate the following HTML:

When using `inline-svg`:
```html
<img src="data:image/svg+xml;base64,..." alt="This is a description" title="This is a diagram" width="200" height="100">
```

When using `inline-png`:
```html
<img src="data:image/png;base64,..." alt="This is a description" title="This is a diagram" width="200" height="100">
```

Both strategies write the same element, so the document is the same either way and only the payload in the `src` differs. The diagram is not spliced into the tree as an `svg`: a renderer between this plugin and the browser can rewrite the attributes of an element it can see, and does not always know what they are — `@nuxtjs/mdc` maps hast's `markerEnd` to an HTML attribute of that name and Vue sets it with `setAttribute`, which SVG, being case sensitive, ignores where `marker-end` defines the arrowhead. A data URI is opaque until the browser draws it, and there the SVG is parsed as the SVG it is. As an SVG document it is also drawn with the fonts D2 embedded in it, which the raster of `inline-png` cannot use.

`title` and `alt` are written out only when you provide them, as metadata or as props; nothing is filled in for you. A block with neither gets an `alt=""`, which is how an image with no description is marked as decorative.

The block is replaced by that element alone: an `img`, with the container tag of `containerTagName` around it and nothing else. No `figure` and no `figcaption` are generated — a caption belongs to the page's own rendering of the image, which is where `alt` and `title` end up, and generating one here would show it twice.

A diagram keeps the size it was drawn at, capped at the width of whatever holds it. D2 gives its SVG a `viewBox` and no dimensions, and an SVG without them has no intrinsic size — a renderer fills its container with it however small the diagram is, and anything that scales an image its own way, a `max-width` or a viewer with a zoom, has no size to scale from. So the size is read back out of the `viewBox` and written in two places: on the element, together with `style="max-width:100%;height:auto"`, and into the diagram itself, as the `width` and `height` of its root `svg` (a diagram that states a size of its own keeps it). The element's copy is what a stylesheet lays the diagram out with; the diagram's own is what every renderer of the image agrees on, including one that shows it without the element around it. A small diagram stays small, a wide one scales down instead of overflowing, and `width`/`height` given as props or metadata change the size it is shown at — an explicit `height` is left as it is, and only a diagram without one gets `height: auto` — while the diagram's own size stays the one it was drawn at.

The raster `inline-png` makes is the drawn size as well, and `pngScale` is for the display it will be read on rather than the page it is written into: `pngScale=2` rasterizes two pixels per drawn pixel, which is what keeps the text in a diagram sharp on a display that draws that many. The element's own `width` and `height` do not change, so a denser raster sharpens the diagram without giving it more room.

See other examples in the fixtures directory [`tests/fixtures`](https://github.com/PrinOrange/rehype-d2/tree/main/tests/fixtures) and [`tests/output`](https://github.com/PrinOrange/rehype-d2/tree/main/tests/output) to see the generated HTML.

## Light and dark themes

The default theme is `default`.

When using multiple themes, this plugin will generate an image for each theme.
It's up to you to define the css to hide or show the diagrams.

For example, if you have a light and dark theme, you can use the following css to hide the light theme:

```css
.dark [data-d2-theme]:not([data-d2-theme="dark"]) {
	display: none;
}
.light [data-d2-theme]:not([data-d2-theme="light"]) {
	display: none;
}
```

Example with markdown:

~~~md
```d2 themes=dark,light
a: From
b: To
a -> b: Message
```
~~~

This will generate the following HTML:

```html
<img data-d2-theme="dark" src="data:image/svg+xml;base64,..." alt="">
<img data-d2-theme="light" src="data:image/svg+xml;base64,..." alt="">
```

# Roadmap

- Reduce the size of the generated images. Currently each diagram contains the fonts, and colors even if they are already defined in another diagram or globally in the html page; writing the diagram into a data URI adds a further third to that, which the base64 encoding is responsible for.

# Integration with other tools

- If you already have a rehype plugin that process code blocks, I suggest placing `rehype-d2` first, so that the code block is unchanged.
- When using with [Nuxt Content](https://content.nuxt.com) (`@nuxtjs/mdc`), no extra configuration is needed: the language marker is looked for on the `pre` wrapping a code block as well as on the `code` element itself, and both the list and the string form of the `class` attribute are accepted. The `pre` is turned into `p` (`containerTagName`), because that renderer's syntax highlighter rewrites any `pre` carrying a `language` property and would highlight the diagram away. What a fence was annotated with — `title="…"`, `alt="…"` — is read from wherever that renderer kept it, a `meta` property on the `pre` beside the language marker. Its renderer also maps the properties of every element onto DOM attributes with the HTML schema, which knows no SVG-only names (`marker-end` and `viewBox` among them) — which is what the `src` of the image is for: the diagram reaches the browser as bytes in a data URI, past any renderer that would take it apart.
- When using with [contentlayer](https://github.com/timlrx/contentlayer2). You might have to patch the `contentlayer` library to avoid bundling the `d2` library. See [issue](https://github.com/timlrx/contentlayer2/issues/70)

# Acknowledgements

- [Rehype Mermaid](https://github.com/remcohaszing/rehype-mermaid) For the inspiration.
