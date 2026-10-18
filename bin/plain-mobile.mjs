#!/usr/bin/env node
// Mobile CLI entrypoint (npm bin). webdriverio 10 needs Node 22.19.
import { refuseOldNode } from './node-check.mjs';
refuseOldNode();
refuseOldNode('22.19');
await import('../dist/mobile/cli.js');
