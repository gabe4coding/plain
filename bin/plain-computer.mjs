#!/usr/bin/env node
// Desktop CLI entrypoint (npm bin).
import { refuseOldNode } from './node-check.mjs';
refuseOldNode('22', 'plain-computer');
await import('../dist/computer/cli.js');
