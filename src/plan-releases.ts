/**
 * Release planner
 *
 *     valenced-plugin plan-releases --pool <dir> [--plugins-dir plugins]... [--dist build/dist] [--out releases.json]
 *
 * A plugin is released when the published pool holds `<id>@<version>.zip`. The pool is the only
 * ledger, so a half-finished publish leaves nothing behind and re-running the release is safe.
 * The pool is keyed by plugin id, which means renaming a plugin folder keeps its history.
 *
 * The plan is a JSON array that CI copies into the pool:
 *
 *     [{ "name": "...", "id": "...", "version": "...", "tag": "...", "zip": "...", "file": "..." }]
 *
 * Run it against a checkout of the published branch to see what a release would publish.
 * It writes nothing to the pool, and it fails on an invalid or downgraded version.
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import {
    compareVersionsFull,
    newestVersion,
    parsePoolFileName,
    parseVersion,
    poolFileName,
} from './generate-index.ts'

export interface PluginSource {
	/** Plugin folder name, which is also the tag prefix. */
	name: string
	id: string
	version: string
}

export interface PlannedRelease extends PluginSource {
	tag: string
	/** Built artifact to publish. */
	zip: string
	/** Name it takes inside the pool. */
	file: string
}

/** Decides which plugins to release. */
export function planReleases(
	plugins: PluginSource[],
	releasedVersions: (id: string) => string[],
	distDir = 'build/dist',
): PlannedRelease[] {
	const plan: PlannedRelease[] = []

	for (const plugin of [...plugins].sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const { name, id, version } = plugin

		try {
			parseVersion(version)
		} catch {
			throw new Error(`${name}: invalid version '${version}'`)
		}

		const released = releasedVersions(id)
		if (released.includes(version)) {
			console.log(`= ${id}@${version} already published`)
			continue
		}

		// The manifest must not go below the newest released version. The total
		// order decides, so promoting `1.2.0-rc` to `1.2.0` is an upgrade.
		const newest = newestVersion(released)
		if (
			newest &&
			compareVersionsFull(parseVersion(version), parseVersion(newest)) < 0
		)
			throw new Error(
				`${name}: manifest version ${version} is below published ${newest}`,
			)

		const file = poolFileName(id, version)
		plan.push({
			name,
			id,
			version,
			tag: `${name}@${version}`,
			zip: `${distDir}/${file}`,
			file,
		})
	}

	return plan
}

/** Reads `<pluginsDir>/<name>/manifest.json` for every plugin in every plugins directory. */
export function readPluginSources(
	pluginsDirs: string[] = ['plugins'],
): PluginSource[] {
	const sources: PluginSource[] = []
	for (const pluginsDir of pluginsDirs) {
		if (!existsSync(pluginsDir))
			throw new Error(`No plugins directory at '${pluginsDir}'`)

		sources.push(...readPluginDir(pluginsDir))
	}
	return sources
}

function readPluginDir(pluginsDir: string): PluginSource[] {
	const sources: PluginSource[] = []
	for (const name of readdirSync(pluginsDir)) {
		const manifestPath = `${pluginsDir}/${name}/manifest.json`
		if (!existsSync(manifestPath)) continue

		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
			id?: string
			version?: string
		}
		if (!manifest.id || !manifest.version)
			throw new Error(`${name}: manifest.json needs both 'id' and 'version'`)

		sources.push({ name, id: manifest.id, version: manifest.version })
	}
	return sources
}

/** Groups the published pool into the versions released per plugin id. */
export function readPooledVersions(poolDir: string): Map<string, string[]> {
	if (!existsSync(poolDir))
		throw new Error(
			`No pool directory at '${poolDir}'. Check out the published branch first, ` +
				'because an absent pool looks like an empty one and republishes everything.',
		)

	const released = new Map<string, string[]>()
	for (const name of readdirSync(poolDir)) {
		if (!name.endsWith('.zip')) continue

		// Every artifact must be `<id>@<version>.zip`. Skipping the odd one out would hide a
		// published version from the planner and let a later release collide with it.
		const parsed = parsePoolFileName(name)
		if (!parsed)
			throw new Error(`${poolDir}/${name}: not an '<id>@<version>.zip' artifact`)

		const versions = released.get(parsed.id)
		if (versions) versions.push(parsed.version)
		else released.set(parsed.id, [parsed.version])
	}
	return released
}

export async function run(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			pool: { type: 'string' },
			'plugins-dir': { type: 'string', multiple: true, default: ['plugins'] },
			dist: { type: 'string', default: 'build/dist' },
			out: { type: 'string', default: 'releases.json' },
			help: { type: 'boolean', short: 'h', default: false },
		},
	})
	if (values.help) {
		console.log(
			'Usage: valenced-plugin plan-releases --pool <dir> [--plugins-dir <dir>]... [--dist <dir>] [--out <file>]',
		)
		return
	}

	if (!values.pool)
		throw new Error(
			'Pass --pool <dir>, a checkout of the published pool that holds <id>@<version>.zip',
		)

	const released = readPooledVersions(values.pool)
	const plan = planReleases(
		readPluginSources(values['plugins-dir']),
		id => released.get(id) ?? [],
		values.dist,
	)

	for (const release of plan) console.log(`+ ${release.file}`)

	const outDir = dirname(values.out)
	if (outDir && outDir !== '.') mkdirSync(outDir, { recursive: true })
	writeFileSync(values.out, `${JSON.stringify(plan, null, 2)}\n`)

	console.log(
		`\u2713 Wrote ${values.out}: ${plan.length} release(s) to publish`,
	)
}
