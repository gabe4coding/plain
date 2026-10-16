// Shared test fixture; the .test name keeps it out of the package (package.json "files" skips *.test.js).
import { createServer } from 'node:http';
import { once } from 'node:events';
import { findMobileNode, parseMobileTree, type MobileNode } from './tree.js';

/** The W3C key of an element reference in a response. */
export const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export type AppiumRequest = { method: string; path: string; body: Record<string, any> };

const allNodes = (nodes: MobileNode[]): MobileNode[] => nodes.flatMap((n) => [n, ...allNodes(n.children)]);

/** The node a lookup names in `source`: by iOS class chain, else by XPath. */
export function lookupNode(source: string, body: Record<string, any>): MobileNode | undefined {
  const roots = parseMobileTree(source).roots;
  return body.using === '-ios class chain' ? allNodes(roots).find((n) => n.chain === body.value) : findMobileNode(roots, body.value);
}

/** `source` as `mobile: source` returns it: without the attributes the request excludes. */
export const withoutAttributes = (source: string, excluded: string): string =>
  excluded.split(',').reduce((xml, name) => xml.replaceAll(new RegExp(` ${name}="[^"]*"`, 'g'), ''), source);

/**
 * A local W3C/Appium server, so tests use the real WebdriverIO transport with no device. It records each request,
 * opens a session for `platform`, and serves `source()` from GET /source and `mobile: source`. `answer` gives the
 * value of a request; when it returns undefined, those answers apply, else null.
 */
export async function appiumFixture(platform: 'android' | 'ios', source: () => string,
  answer: (request: AppiumRequest) => unknown = () => undefined) {
  const ios = platform === 'ios';
  const requests: AppiumRequest[] = [];
  const shared = ({ method, path, body }: AppiumRequest): unknown => {
    if (path === '/wd/hub/session' && method === 'POST') return { sessionId: 'fixture', capabilities: {
      platformName: ios ? 'iOS' : 'Android', 'appium:automationName': ios ? 'XCUITest' : 'UiAutomator2' } };
    if (path.endsWith('/source')) return source();
    if (path.endsWith('/execute/sync') && body.script === 'mobile: source') return withoutAttributes(source(), body.args[0].excludedAttributes);
    return null;
  };
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const request = { method: req.method!, path: req.url!, body: text ? JSON.parse(text) : {} };
    requests.push(request);
    const own = answer(request);
    const value = own === undefined ? shared(request) : own;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/wd/hub`,
    requests,
    async close() { server.close(); server.closeAllConnections(); await once(server, 'close'); },
  };
}
