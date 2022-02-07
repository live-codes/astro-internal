import { renderPage } from '../@astro/internal';
export * from '@astrojs/compiler';

export async function renderAstroToHTML(content: string): Promise<string | { errors: string[] }> {
  const url = `data:application/javascript;base64,${globalThis.Buffer ? Buffer.from(content).toString('base64') : btoa(content)}`;
  let mod;
  let html;
  try {
    ({ default: mod } = await import(url));
  } catch (e) {
    return {
      errors: [e],
    };
  }
  if (!mod) {
    return;
  }

  try {
    html = await renderPage(
      {
        _metadata: {
          // renderers: [],
          // pathname: '',
          experimentalStaticBuild: false,
        },
        links: new Set(),
        styles: new Set(),
        scripts: new Set(),
        /** This function returns the `Astro` faux-global */
        createAstro(astroGlobal: any, props: Record<string, any>, slots: Record<string, any> | null) {
          const url = new URL('http://localhost:3000/');
          const canonicalURL = url;
          return {
            __proto__: astroGlobal,
            props,
            // fetchContent,
            //  resolve,
            //   site
            request: {
              canonicalURL,
              params: {},
              url,
            },
            slots: Object.fromEntries(Object.entries(slots || {}).map(([slotName]) => [slotName, true])),
          };
        },
      },
      await mod,
      {},
      {}
    );
  } catch (e) {
    return {
      errors: [e],
    };
  }
  return html;
}
