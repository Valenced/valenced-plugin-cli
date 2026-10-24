/**
 * Local repository dev server
 *
 * Regenerates the index from your built plugin ZIPs and serves it together with the ZIPs,
 * so you can add the printed URL as a repository and go through the browse/install/update flow against local builds.
 *
 *   valenced-plugin serve                                  # LAN mode
 *   valenced-plugin serve --base-url http://127.0.0.1:8080 # local mode
 *
 * Flags:
 *   --dist <dir>       directory of plugin ZIPs (default build/dist)
 *   --port <port>      port to listen on (default 8080)
 *   --host <ip>        IP to announce in artifact URLs (default: detected LAN IPv4)
 *   --base-url <url>   full base URL to announce, overrides --host/--port for URLs
 *
 * The dist directory is rescanned on every network request. Indexes will auto-update without restarting the server.
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { parseArgs } from 'node:util'
import { generateIndex, loadRepoConfig } from './generate-index.ts'
import type { Artifact } from './generate-index.ts'

function detectLanIp(): string | null {
	for (const infos of Object.values(networkInterfaces()))
		for (const info of infos ?? [])
			if (info.family === 'IPv4' && !info.internal) return info.address
	return null
}

export async function run(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			dist: { type: 'string', default: 'build/dist' },
			port: { type: 'string', default: '8080' },
			host: { type: 'string' },
			'base-url': { type: 'string' },
			help: { type: 'boolean', short: 'h', default: false },
		},
	})
	if (values.help) {
		console.log(
			'Usage: valenced-plugin serve [--dist <dir>] [--port <port>] [--host <ip>] [--base-url <url>]',
		)
		return
	}

	const dist = values.dist
	const port = Number(values.port)
	const host = values.host ?? detectLanIp() ?? '127.0.0.1'
	const baseUrl = (values['base-url'] ?? `http://${host}:${port}`).replace(
		/\/$/,
		'',
	)

	function scanZips(): string[] {
		if (!existsSync(dist)) return []
		return readdirSync(dist)
			.filter(name => name.endsWith('.zip'))
			.sort()
	}

	if (!scanZips().length) {
		console.error(
			`No plugin ZIPs in ${dist}. Run the build first:\n  ./gradlew packageAllPlugins   (or \`valenced-plugin build\` for JS bundles, see README)`,
		)
		process.exit(1)
	}

	// The index and the servable file set are rebuilt together whenever the dist
	// contents change, so artifact URLs and reality can't diverge.
	let fingerprint = ''
	let indexBody = ''
	// URL path ("/<name>.zip") to file path. Only indexed ZIPs are ever served.
	let artifactPaths = new Map<string, string>()

	function rebuildIfChanged() {
		const zips = scanZips()
		const current = zips
			.map(name => {
				const stat = statSync(`${dist}/${name}`)
				return `${name}:${stat.size}:${stat.mtimeMs}`
			})
			.join('\n')
		if (current === fingerprint) return

		const artifacts: Artifact[] = zips.map(name => ({
			file: `${dist}/${name}`,
			url: `${baseUrl}/${name}`,
		}))

		const index = generateIndex(artifacts, loadRepoConfig())
		indexBody = `${JSON.stringify(index, null, 2)}\n`
		artifactPaths = new Map(
			artifacts.map(a => [`/${a.file.split('/').pop()}`, a.file]),
		)
		fingerprint = current
		console.log(
			`\u2713 Index rebuilt: ${Object.keys(index.plugins).length} plugin(s), ${zips.length} artifact(s)`,
		)
	}

	rebuildIfChanged()

	const server = createServer((req, res) => {
		const { pathname } = new URL(req.url ?? '/', baseUrl)

		if (pathname === '/index.json') {
			try {
				rebuildIfChanged()
			} catch (e) {
				console.error(e)
				res.writeHead(500, { 'Content-Type': 'text/plain' })
				res.end(String(e))
				return
			}
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
			})
			res.end(indexBody)
			return
		}

		const file = artifactPaths.get(pathname)
		if (file) {
			res.writeHead(200, {
				'Content-Type': 'application/zip',
				'Content-Length': statSync(file).size,
				'Cache-Control': 'no-store',
			})
			createReadStream(file).pipe(res)
			return
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' })
		res.end('Not found')
	})

	server.listen(port, '0.0.0.0', () => {
		console.log(`Serving local plugin repository on port ${port}`)
		console.log(`  Repository URL: ${baseUrl}`)
		if (baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost'))
			console.log(`  Device setup:   adb reverse tcp:${port} tcp:${port}`)
	})
}
