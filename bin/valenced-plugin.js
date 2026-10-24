#!/usr/bin/env node
import { existsSync } from 'node:fs'

const dist = new URL('../dist/main.js', import.meta.url)
const src = new URL('../src/main.ts', import.meta.url)

const installed = import.meta.url.includes('/node_modules/')
const entry = installed
	? existsSync(dist)
		? dist
		: src
	: existsSync(src)
		? src
		: dist

await import(entry.href)
