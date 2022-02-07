import shorthash from 'shorthash';
import { extractDirectives, generateHydrateScript } from './hydration';
import { serializeListValue } from './util';

import { extname } from '../../utils/loader';

export { createMetadata } from './metadata';
export type { Metadata } from './metadata';

import type { AstroComponentMetadata, AstroConfig, AstroGlobal, AstroGlobalPartial, Params, Renderer, SSRElement, SSRResult } from "astro";

const voidElementNames = /^(area|base|br|col|command|embed|hr|img|input|keygen|link|meta|param|source|track|wbr)$/i;

// INVESTIGATE:
// 2. Less anys when possible and make it well known when they are needed.

// Used to render slots and expressions
// INVESTIGATE: Can we have more specific types both for the argument and output?
// If these are intentional, add comments that these are intention and why.
// Or maybe type UserValue = any; ?
async function _render(child: any): Promise<any> {
	child = await child;
	if (Array.isArray(child)) {
		return (await Promise.all(child.map((value) => _render(value)))).join('');
	} else if (typeof child === 'function') {
		// Special: If a child is a function, call it automatically.
		// This lets you do {() => ...} without the extra boilerplate
		// of wrapping it in a function and calling it.
		return _render(child());
	} else if (typeof child === 'string') {
		return child;
	} else if (!child && child !== 0) {
		// do nothing, safe to ignore falsey values.
	}
	// Add a comment explaining why each of these are needed.
	// Maybe create clearly named function for what this is doing.
	else if (child instanceof AstroComponent || Object.prototype.toString.call(child) === '[object AstroComponent]') {
		return await renderAstroComponent(child);
	} else {
		return child;
	}
}

// The return value when rendering a component.
// This is the result of calling render(), should this be named to RenderResult or...?
export class AstroComponent {
	private htmlParts: TemplateStringsArray;
	private expressions: any[];

	constructor(htmlParts: TemplateStringsArray, expressions: any[]) {
		this.htmlParts = htmlParts;
		this.expressions = expressions;
	}

	get [Symbol.toStringTag]() {
		return 'AstroComponent';
	}

	*[Symbol.iterator]() {
		const { htmlParts, expressions } = this;

		for (let i = 0; i < htmlParts.length; i++) {
			const html = htmlParts[i];
			const expression = expressions[i];

			yield _render(html);
			yield _render(expression);
		}
	}
}

export async function render(htmlParts: TemplateStringsArray, ...expressions: any[]) {
	return new AstroComponent(htmlParts, expressions);
}

// The callback passed to to $$createComponent
export interface AstroComponentFactory {
	(result: any, props: any, slots: any): ReturnType<typeof render>;
	isAstroComponentFactory?: boolean;
}

// Used in creating the component. aka the main export.
export function createComponent(cb: AstroComponentFactory) {
	// Add a flag to this callback to mark it as an Astro component
	// INVESTIGATE does this need to cast
	(cb as any).isAstroComponentFactory = true;
	return cb;
}

export async function renderSlot(_result: any, slotted: string, fallback?: any) {
	if (slotted) {
		return _render(slotted);
	}
	return fallback;
}

export const Fragment = Symbol('Astro.Fragment');

function guessRenderers(componentUrl?: string): string[] {
	const extname = componentUrl?.split('.').pop();
	switch (extname) {
		case 'svelte':
			return ['@astrojs/renderer-svelte'];
		case 'vue':
			return ['@astrojs/renderer-vue'];
		case 'jsx':
		case 'tsx':
			return ['@astrojs/renderer-react', '@astrojs/renderer-preact'];
		default:
			return ['@astrojs/renderer-react', '@astrojs/renderer-preact', '@astrojs/renderer-vue', '@astrojs/renderer-svelte'];
	}
}

function formatList(values: string[]): string {
	if (values.length === 1) {
		return values[0];
	}
	return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

export async function renderComponent(result: SSRResult, displayName: string, Component: unknown, _props: Record<string | number, any>, slots: any = {}) {
	Component = await Component;
	const children = await renderSlot(result, slots?.default);

	if (Component === Fragment) {
		return children;
	}

	if (Component && (Component as any).isAstroComponentFactory) {
		const output = await renderToString(result, Component as any, _props, slots);
		return output;
	}

	if (Component === null && !_props['client:only']) {
		throw new Error(`Unable to render ${displayName} because it is ${Component}!\nDid you forget to import the component or is it possible there is a typo?`);
	}

	const { renderers } = result._metadata;
	const metadata: AstroComponentMetadata = { displayName };

	const { hydration, props } = extractDirectives(_props);
	let html = '';

	if (hydration) {
		metadata.hydrate = hydration.directive as AstroComponentMetadata['hydrate'];
		metadata.hydrateArgs = hydration.value;
		metadata.componentExport = hydration.componentExport;
		metadata.componentUrl = hydration.componentUrl;
	}
	const probableRendererNames = guessRenderers(metadata.componentUrl);

	if (Array.isArray(renderers) && renderers.length === 0 && typeof Component !== 'string') {
		const message = `Unable to render ${metadata.displayName}!

There are no \`renderers\` set in your \`astro.config.mjs\` file.
Did you mean to enable ${formatList(probableRendererNames.map((r) => '`' + r + '`'))}?`;
		throw new Error(message);
	}

	// Call the renderers `check` hook to see if any claim this component.
	let renderer: Renderer | undefined;
	if (metadata.hydrate !== 'only') {
		for (const r of renderers) {
			if (await r.ssr.check(Component, props, children)) {
				renderer = r;
				break;
			}
		}
	} else {
		// Attempt: use explicitly passed renderer name
		if (metadata.hydrateArgs) {
			const rendererName = metadata.hydrateArgs;
			renderer = renderers.filter(({ name }) => name === `@astrojs/renderer-${rendererName}` || name === rendererName)[0];
		}
		// Attempt: user only has a single renderer, default to that
		if (!renderer && renderers.length === 1) {
			renderer = renderers[0];
		}
		// Attempt: can we guess the renderer from the export extension?
		if (!renderer) {
			const extname = metadata.componentUrl?.split('.').pop();
			renderer = renderers.filter(({ name }) => name === `@astrojs/renderer-${extname}` || name === extname)[0];
		}
	}

	// If no one claimed the renderer
	if (!renderer) {
		if (metadata.hydrate === 'only') {
			// TODO: improve error message
			throw new Error(`Unable to render ${metadata.displayName}!

Using the \`client:only\` hydration strategy, Astro needs a hint to use the correct renderer.
Did you mean to pass <${metadata.displayName} client:only="${probableRendererNames.map((r) => r.replace('@astrojs/renderer-', '')).join('|')}" />
`);
		} else if (typeof Component !== 'string') {
			const matchingRenderers = renderers.filter((r) => probableRendererNames.includes(r.name));
			const plural = renderers.length > 1;
			if (matchingRenderers.length === 0) {
				throw new Error(`Unable to render ${metadata.displayName}!

There ${plural ? 'are' : 'is'} ${renderers.length} renderer${plural ? 's' : ''} configured in your \`astro.config.mjs\` file,
but ${plural ? 'none were' : 'it was not'} able to server-side render ${metadata.displayName}.

Did you mean to enable ${formatList(probableRendererNames.map((r) => '`' + r + '`'))}?`);
			} else {
				throw new Error(`Unable to render ${metadata.displayName}!

This component likely uses ${formatList(probableRendererNames)},
but Astro encountered an error during server-side rendering.

Please ensure that ${metadata.displayName}:
1. Does not unconditionally access browser-specific globals like \`window\` or \`document\`.
   If this is unavoidable, use the \`client:only\` hydration directive.
2. Does not conditionally return \`null\` or \`undefined\` when rendered on the server.

If you're still stuck, please open an issue on GitHub or join us at https://astro.build/chat.`);
			}
		}
	} else {
		if (metadata.hydrate === 'only') {
			html = await renderSlot(result, slots?.fallback);
		} else {
			({ html } = await renderer.ssr.renderToStaticMarkup(Component, props, children));
		}
	}

	// This is a custom element without a renderer. Because of that, render it
	// as a string and the user is responsible for adding a script tag for the component definition.
	if (!html && typeof Component === 'string') {
		html = await renderAstroComponent(
			await render`<${Component}${spreadAttributes(props)}${(children == null || children == '') && voidElementNames.test(Component) ? `/>` : `>${children}</${Component}>`}`
		);
	}

	// This is used to add polyfill scripts to the page, if the renderer needs them.
	if (renderer?.polyfills?.length) {
		for (const src of renderer.polyfills) {
			result.scripts.add({
				props: { type: 'module' },
				children: `import "${await result.resolve(src)}";`,
			});
		}
	}

	if (!hydration) {
		return html.replace(/\<\/?astro-fragment\>/g, '');
	}

	// Include componentExport name and componentUrl in hash to dedupe identical islands
	const astroId = shorthash.unique(`<!--${metadata.componentExport!.value}:${metadata.componentUrl}-->\n${html}`);

	// Rather than appending this inline in the page, puts this into the `result.scripts` set that will be appended to the head.
	// INVESTIGATE: This will likely be a problem in streaming because the `<head>` will be gone at this point.
	result.scripts.add(await generateHydrateScript({ renderer, result, astroId, props }, metadata as Required<AstroComponentMetadata>));

	return `<astro-root uid="${astroId}">${html ?? ''}</astro-root>`;
}

/** Create the Astro.fetchContent() runtime function. */
function createFetchContentFn(url: URL) {
	const fetchContent = (importMetaGlobResult: Record<string, any>) => {
		let allEntries = [...Object.entries(importMetaGlobResult)];
		if (allEntries.length === 0) {
			throw new Error(`[${url.pathname}] Astro.fetchContent() no matches found.`);
		}
		return allEntries
			.map(([spec, mod]) => {
				// Only return Markdown files for now.
				if (!mod.frontmatter) {
					return;
				}
				const urlSpec = new URL(spec, url).pathname;
				return {
					...mod.frontmatter,
					Content: mod.default,
					content: mod.metadata,
					file: new URL(spec, url),
					url: urlSpec.includes('/pages/') ? urlSpec.replace(/^.*\/pages\//, '/').replace(/(\/index)?\.md$/, '') : undefined,
				};
			})
			.filter(Boolean);
	};
	// This has to be cast because the type of fetchContent is the type of the function
	// that receives the import.meta.glob result, but the user is using it as
	// another type.
	return fetchContent as unknown as AstroGlobalPartial['fetchContent'];
}

// This is used to create the top-level Astro global; the one that you can use
// Inside of getStaticPaths.
export function createAstro(filePathname: string, site: string, projectRootStr: string): AstroGlobalPartial {
	const url = new URL(filePathname, site);
	const projectRoot = new URL(projectRootStr, site);
	const fetchContent = createFetchContentFn(url);
	return {
		site: new URL(site),
		fetchContent,
		// INVESTIGATE is there a use-case for multi args?
		resolve(...segments: string[]) {
			let resolved = segments.reduce((u, segment) => new URL(segment, u), url).pathname;
			// When inside of project root, remove the leading path so you are
			// left with only `/src/images/tower.png`
			if (resolved.startsWith(projectRoot.pathname)) {
				resolved = '/' + resolved.substr(projectRoot.pathname.length);
			}
			return resolved;
		},
	};
}

const toAttributeString = (value: any) => String(value).replace(/&/g, '&#38;').replace(/"/g, '&#34;');

// A helper used to turn expressions into attribute key/value
export function addAttribute(value: any, key: string) {
	if (value == null || value === false) {
		return '';
	}

	// support "class" from an expression passed into an element (#782)
	if (key === 'class:list') {
		return ` ${key.slice(0, -5)}="${toAttributeString(serializeListValue(value))}"`;
	}

	// Boolean only needs the key
	if (value === true && key.startsWith('data-')) {
		return ` ${key}`;
	} else {
		return ` ${key}="${toAttributeString(value)}"`;
	}
}

// Adds support for `<Component {...value} />
export function spreadAttributes(values: Record<any, any>) {
	let output = '';
	for (const [key, value] of Object.entries(values)) {
		output += addAttribute(value, key);
	}
	return output;
}

// Adds CSS variables to an inline style tag
export function defineStyleVars(selector: string, vars: Record<any, any>) {
	let output = '\n';
	for (const [key, value] of Object.entries(vars)) {
		output += `  --${key}: ${value};\n`;
	}
	return `${selector} {${output}}`;
}

// Adds variables to an inline script.
export function defineScriptVars(vars: Record<any, any>) {
	let output = '';
	for (const [key, value] of Object.entries(vars)) {
		output += `let ${key} = ${JSON.stringify(value)};\n`;
	}
	return output;
}

// Calls a component and renders it into a string of HTML
export async function renderToString(result: SSRResult, componentFactory: AstroComponentFactory, props: any, children: any) {
	const Component = await componentFactory(result, props, children);
	let template = await renderAstroComponent(Component);
	return template;
}

// Filter out duplicate elements in our set
const uniqueElements = (item: any, index: number, all: any[]) => {
	const props = JSON.stringify(item.props);
	const children = item.children;
	return index === all.findIndex((i) => JSON.stringify(i.props) === props && i.children == children);
};

// Renders a page to completion by first calling the factory callback, waiting for its result, and then appending
// styles and scripts into the head.
export async function renderPage(result: SSRResult, Component: AstroComponentFactory, props: any, children: any) {
	const template = await renderToString(result, Component, props, children);
	const styles = result._metadata.experimentalStaticBuild
		? []
		: Array.from(result.styles)
				.filter(uniqueElements)
				.map((style) =>
					renderElement('style', {
						...style,
						props: { ...style.props, 'astro-style': true },
					})
				);
	let needsHydrationStyles = false;
	const scripts = Array.from(result.scripts)
		.filter(uniqueElements)
		.map((script, i) => {
			if ('data-astro-component-hydration' in script.props) {
				needsHydrationStyles = true;
			}
			return renderElement('script', {
				...script,
				props: { ...script.props, 'astro-script': result._metadata.pathname + '/script-' + i },
			});
		});
	if (needsHydrationStyles) {
		styles.push(renderElement('style', { props: { 'astro-style': true }, children: 'astro-root, astro-fragment { display: contents; }' }));
	}

	const links = Array.from(result.links)
		.filter(uniqueElements)
		.map((link) => renderElement('link', link));

	// inject styles & scripts at end of <head>
	let headPos = template.indexOf('</head>');
	if (headPos === -1) {
		return links.join('\n') + styles.join('\n') + scripts.join('\n') + template; // if no </head>, prepend styles & scripts
	}
	return template.substring(0, headPos) + links.join('\n') + styles.join('\n') + scripts.join('\n') + template.substring(headPos);
}

export async function renderAstroComponent(component: InstanceType<typeof AstroComponent>) {
	let template = '';

	for await (const value of component) {
		if (value || value === 0) {
			template += value;
		}
	}

	return template;
}

function renderElement(name: string, { props: _props, children = '' }: SSRElement) {
	// Do not print `hoist`, `lang`, `global`
	const { lang: _, 'data-astro-id': astroId, 'define:vars': defineVars, ...props } = _props;
	if (defineVars) {
		if (name === 'style') {
			if (props.global) {
				children = defineStyleVars(`:root`, defineVars) + '\n' + children;
			} else {
				children = defineStyleVars(`.astro-${astroId}`, defineVars) + '\n' + children;
			}
			delete props.global;
		}
		if (name === 'script') {
			delete props.hoist;
			children = defineScriptVars(defineVars) + '\n' + children;
		}
	}
	return `<${name}${spreadAttributes(props)}>${children}</${name}>`;
}

// https://vitejs.dev/guide/features.html#css-pre-processors
export const STYLE_EXTENSIONS = new Set(['.css', '.pcss', '.postcss', '.scss', '.sass', '.styl', '.stylus', '.less']);

const cssRe = new RegExp(
	`\\.(${Array.from(STYLE_EXTENSIONS)
		.map((s) => s.slice(1))
		.join('|')})($|\\?)`
);
export const isCSSRequest = (request: string): boolean => cssRe.test(request);

/** Normalize URL to its canonical form */
export function getCanonicalURL(url: string, base?: string): URL {
	let pathname = url.replace(/\/index.html$/, ''); // index.html is not canonical
	pathname = pathname.replace(/\/1\/?$/, ''); // neither is a trailing /1/ (impl. detail of collections)
	if (!extname(pathname)) pathname = pathname.replace(/(\/+)?$/, '/'); // add trailing slash if there’s no extension
	pathname = pathname.replace(/\/+/g, '/'); // remove duplicate slashes (URL() won’t)
	return new URL(pathname, base);
}

export interface CreateResultArgs {
	astroConfig: AstroConfig;
	logging: any;
	origin: string;
	params: Params;
	pathname: string;
	renderers: Renderer[];
}

export function createResult(args: CreateResultArgs): SSRResult {
	const { astroConfig, origin, params, pathname, renderers } = args;

	// Create the result object that will be passed into the render function.
	// This object starts here as an empty shell (not yet the result) but then
	// calling the render() function will populate the object with scripts, styles, etc.
	const result: SSRResult = {
		styles: new Set<SSRElement>(),
		scripts: new Set<SSRElement>(),
		links: new Set<SSRElement>(),
		/** This function returns the `Astro` faux-global */
		createAstro(astroGlobal: AstroGlobalPartial, props: Record<string, any>, slots: Record<string, any> | null) {
			const site = new URL(origin);
			const url = new URL('.' + pathname, site);
			const canonicalURL = getCanonicalURL('.' + pathname, astroConfig.buildOptions.site || origin);
			return {
				__proto__: astroGlobal,
				props,
				request: {
					canonicalURL,
					params,
					url,
				},
				resolve(path: string) {
					if (astroConfig.buildOptions.experimentalStaticBuild) {
						let extra = `This can be replaced with a dynamic import like so: await import("${path}")`;
						if (isCSSRequest(path)) {
							extra = `It looks like you are resolving styles. If you are adding a link tag, replace with this:
<style global>
@import "${path}";
</style>
`;
						}

						console.warn(
							`deprecation`,
							`**${'Astro.resolve()'}** is deprecated. We see that you are trying to resolve ${path}.
${extra}`
						);
						// Intentionally return an empty string so that it is not relied upon.
						return '';
					}

					return astroGlobal.resolve(path);
				},
				slots: Object.fromEntries(Object.entries(slots || {}).map(([slotName]) => [slotName, true])),
				// This is used for <Markdown> but shouldn't be used publicly
				privateRenderSlotDoNotUse(slotName: string) {
					return renderSlot(result, slots ? slots[slotName] : null);
				},
				// <Markdown> also needs the same `astroConfig.markdownOptions.render` as `.md` pages
				async privateRenderMarkdownDoNotUse(content: string, opts: any) {
					let mdRender = astroConfig.markdownOptions.render;
					let renderOpts = {};
					if (Array.isArray(mdRender)) {
						renderOpts = mdRender[1];
						mdRender = mdRender[0];
					}
					// ['rehype-toc', opts]
					if (typeof mdRender === 'string') {
						({ default: mdRender } = await import(mdRender));
					}
					// [import('rehype-toc'), opts]
					else if (mdRender instanceof Promise) {
						({ default: mdRender } = await mdRender);
					}
					const { code } = await mdRender(content, { ...renderOpts, ...(opts ?? {}) });
					return code;
				},
			} as unknown as AstroGlobal;
		},
		// This is a stub and will be implemented by dev and build.
		async resolve(s: string): Promise<string> {
			return '';
		},
		_metadata: {
			renderers,
			pathname,
			experimentalStaticBuild: astroConfig?.buildOptions?.experimentalStaticBuild,
		},
	};

	return result;
}