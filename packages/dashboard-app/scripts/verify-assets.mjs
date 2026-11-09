import { readFileSync, readdirSync } from 'node:fs';
const root = new URL('../dist/console/dashboard/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const paths = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(([, path]) => path);
if (paths.length !== 2 || !paths.every((path) => /^\/console\/dashboard\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(path))) throw new Error('Dashboard asset paths are not bounded content-hashed JS/CSS');
const files = readdirSync(new URL('assets/', root));
if (files.length !== paths.length || files.some((name) => !paths.some((path) => path.endsWith('/' + name)))) throw new Error('Dashboard assets are missing or have unexpected files');
for (const path of paths) if (readFileSync(new URL(`assets/${path.split('/').at(-1)}`, root)).length === 0) throw new Error('Empty dashboard asset');
console.log('dashboard assets: bounded content hashes and matching files');
