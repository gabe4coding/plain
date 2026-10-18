#!/usr/bin/env node
// Mobile CLI entrypoint (npm bin). webdriverio 10 needs Node 22.19.
import { refuseOldNode } from './node-check.mjs';
refuseOldNode('22', 'plain-mobile');
refuseOldNode('22.19', 'plain-mobile');
await import('../dist/mobile/cli.js');
