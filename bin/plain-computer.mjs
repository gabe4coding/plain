#!/usr/bin/env node
// Desktop CLI entrypoint (npm bin).
import { refuseOldNode } from './node-check.mjs';
refuseOldNode();
await import('../dist/computer/cli.js');
