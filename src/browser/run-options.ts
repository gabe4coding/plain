export interface RunOptions {
  headed: boolean;
  timeout: number;
  /** Persistent user-data dir: cookies and logins survive between runs. Ignored when `cdp` is set. */
  profile?: string;
  /** Attach to a running Chrome over CDP instead of launching one. */
  cdp?: string;
  /** Playwright browser channel to launch instead of the bundled Chromium. */
  channel?: string;
  /** The MCP server owns shutdown, so Playwright must not race its cleanup on process signals. */
  handleSignals?: boolean;
  specTimeout?: number;
}
