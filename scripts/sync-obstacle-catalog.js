#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardRoot = path.resolve(__dirname, '..');
const source = path.resolve(dashboardRoot, '..', 'marble-race', 'src', 'obstacle-catalog.json');
const targetDir = path.join(dashboardRoot, 'shared');
const target = path.join(targetDir, 'obstacle-catalog.json');

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`[game-dashboard] synced obstacle catalog: ${source} -> ${target}`);
