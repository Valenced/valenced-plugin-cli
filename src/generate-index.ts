/**
 * Repository index generator
 *
 *   Local mode: a directory of plugin ZIPs:
 *       valenced-plugin generate-index --dist build/dist --base-url http://192.168.1.2:8080 [--out index.json]
 *
 *   Descriptor mode: a pre-built list of local ZIPs and their final URLs:
 *       valenced-plugin generate-index --releases releases.json [--out index.json]
 *
 *     Descriptor shape: [{ "file": "<local path to the ZIP>", "url": "<final absolute asset URL>" }]
 *
 * Optional `repo.config.json` (repo display metadata + channel overrides):
 *   { "name": "...", "description": "...", "icon": "...", "channels": { "<plugin id>": { "<channel>": "<version>" } } }
 *
 * Channel pointers are automatic unless overridden:
 *   - `latest`  = newest non-labeled version
 *   - `beta` = newest version overall (only emitted when it differs from `latest`)
 */

import { createHash } from 'node:crypto'
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { unzipSync } from 'fflate'

const INDEX_FORMAT = 1

interface Version {
	nums: number[]
	label: string | null
}

const VERSION_REGEX = /^(\d+(?:\.\d+)*)(?:-([a-z0-9]+))?$/

export function parseVersion(value: string): Version {
	const match = VERSION_REGEX.exec(value)
	if (!match) throw new Error(`Invalid version: '${value}'`)
	const [, nums = '', label] = match
	return {
		nums: nums.split('.').map(Number),
		label: label ?? null,
	}
}

// Integers-only comparison, as used for range satisfaction. Labels are ignored.
export function compareVersions(a: Version, b: Version): number {
	const len = Math.max(a.nums.length, b.nums.length)
	for (let i = 0; i < len; i++) {
		const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}

// Alternating runs of non-digits and digits: non-digits byte-lexically, digits numerically, so `rc2` < `rc10`.
function compareLabels(a: string, b: string): number {
	const runs = (label: string) => label.match(/\d+|\D+/g) ?? []
	const left = runs(a)
	const right = runs(b)

	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const x = left[i]
		const y = right[i]
		if (x === undefined) return -1
		if (y === undefined) return 1

		const bothDigits = /^\d/.test(x) && /^\d/.test(y)
		const diff = bothDigits ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0
		if (diff !== 0) return diff
	}
	return 0
}

export function compareVersionsFull(a: Version, b: Version): number {
	const nums = compareVersions(a, b)
	if (nums !== 0) return nums
	if (a.label === b.label) return 0
	if (a.label === null) return 1
	if (b.label === null) return -1
	return compareLabels(a.label, b.label)
}

/** Newest of `versions` by the total order, or `null` when empty. */
export function newestVersion(versions: string[]): string | null {
	return versions.reduce<string | null>(
		(best, cur) =>
			best === null ||
			compareVersionsFull(parseVersion(cur), parseVersion(best)) > 0
				? cur
				: best,
		null,
	)
}

function readZipEntry(zip: Uint8Array, entryName: string): Uint8Array | null {
	const entries = unzipSync(zip, { filter: file => file.name === entryName })
	return entries[entryName] ?? null
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

const MANIFEST_FORMAT = 1
const PLUGIN_ID_REGEX = /^[a-zA-Z0-9.-]+$/
// Reserved dependencies every plugin must declare
const RESERVED_DEPENDENCY_IDS = ['valenced.api', 'discord']

interface Manifest {
	format: number
	id: string
	name: string
	description?: string
	author?: string
	contributors?: string[]
	icon?: string
	version: string
	dependencies?: Record<string, { version?: string; optional?: boolean }>
}

function validateManifest(manifest: Manifest, source: string): void {
	if (manifest.format !== MANIFEST_FORMAT)
		throw new Error(`${source}: unsupported manifest format ${manifest.format}`)
	if (
		!PLUGIN_ID_REGEX.test(manifest.id) ||
		manifest.id.includes('..') ||
		manifest.id.startsWith('.')
	)
		throw new Error(`${source}: invalid plugin id '${manifest.id}'`)
	parseVersion(manifest.version)
	if (
		manifest.contributors !== undefined &&
		!(
			Array.isArray(manifest.contributors) &&
			manifest.contributors.every(c => typeof c === 'string')
		)
	)
		throw new Error(`${source}: contributors must be an array of strings`)
	const deps = manifest.dependencies ?? {}
	for (const reservedId of RESERVED_DEPENDENCY_IDS)
		if (!(reservedId in deps))
			throw new Error(`${source}: missing mandatory '${reservedId}' dependency`)
	for (const [depId, dep] of Object.entries(deps)) {
		if (!PLUGIN_ID_REGEX.test(depId))
			throw new Error(`${source}: invalid dependency id '${depId}'`)
		if (dep.optional && RESERVED_DEPENDENCY_IDS.includes(depId))
			throw new Error(`${source}: '${depId}' cannot be optional`)
	}
	// Only allow data: URLs or asset names for icons
	if (
		manifest.icon &&
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(manifest.icon) &&
		!manifest.icon.startsWith('data:')
	)
		throw new Error(
			`${source}: icon must be an asset name or a data: URL, not a remote URL`,
		)
}

export function poolFileName(id: string, version: string): string {
	return `${id}@${version}.zip`
}

export function parsePoolFileName(
	name: string,
): { id: string; version: string } | null {
	const match = /^([^@/\\]+)@([^@/\\]+)\.zip$/.exec(name)
	if (!match) return null

	const [, id = '', version = ''] = match
	if (!PLUGIN_ID_REGEX.test(id) || !VERSION_REGEX.test(version)) return null
	return { id, version }
}

// ---------------------------------------------------------------------------
// Index generation
// ---------------------------------------------------------------------------

interface Artifact {
	file: string
	url: string
}

export type { Artifact }

export interface RepoConfig {
	name?: string
	description?: string
	icon?: string
	channels?: Record<string, Record<string, string>>
}

export function loadRepoConfig(path = 'repo.config.json'): RepoConfig {
	return existsSync(path)
		? (JSON.parse(readFileSync(path, 'utf8')) as RepoConfig)
		: {}
}

export function collectArtifacts(args: {
	dist?: string
	baseUrl?: string
	releases?: string
}): Artifact[] {
	if (args.releases) {
		const descriptor = JSON.parse(
			readFileSync(args.releases, 'utf8'),
		) as Artifact[]
		for (const artifact of descriptor) {
			if (!artifact.file || !artifact.url)
				throw new Error('Release descriptor entries need { file, url }')
			if (!/^https?:\/\//.test(artifact.url))
				throw new Error(`Artifact URL must be absolute: '${artifact.url}'`)
		}
		return descriptor
	}

	if (args.dist) {
		if (!args.baseUrl)
			throw new Error(
				'--dist mode requires --base-url for absolute artifact URLs',
			)
		const base = args.baseUrl.replace(/\/$/, '')
		// Sorted so the index is deterministic across runtimes/filesystems.
		return readdirSync(args.dist)
			.filter(name => name.endsWith('.zip'))
			.sort()
			.map(name => {
				if (!parsePoolFileName(name))
					throw new Error(
						`${args.dist}/${name}: artifacts must be named <id>@<version>.zip`,
					)
				return { file: `${args.dist}/${name}`, url: `${base}/${name}` }
			})
	}

	throw new Error(
		'Pass --dist <dir> --base-url <url>, or --releases <descriptor.json>',
	)
}

interface IndexVersion {
	url: string
	sha256: string
	size: number
	dependencies: Record<string, { version?: string; optional?: boolean }>
}

interface IndexPlugin {
	name: string
	description: string
	author: string
	contributors?: string[]
	icon?: string
	channels: Record<string, string>
	versions: Record<string, IndexVersion>
}

export async function run(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			dist: { type: 'string' },
			'base-url': { type: 'string' },
			releases: { type: 'string' },
			out: { type: 'string', default: 'index.json' },
			help: { type: 'boolean', short: 'h', default: false },
		},
	})
	if (values.help) {
		console.log(
			'Usage: valenced-plugin generate-index (--dist <dir> --base-url <url> | --releases <descriptor.json>) [--out <file>]',
		)
		return
	}

	const artifacts = collectArtifacts({
		dist: values.dist,
		baseUrl: values['base-url'],
		releases: values.releases,
	})
	const index = generateIndex(artifacts, loadRepoConfig())

	const outDir = dirname(values.out)
	if (outDir && outDir !== '.') mkdirSync(outDir, { recursive: true })
	writeFileSync(values.out, `${JSON.stringify(index, null, 2)}\n`)
	console.log(
		`\u2713 Wrote ${values.out}: ${Object.keys(index.plugins).length} plugin(s), ${artifacts.length} artifact(s)`,
	)
}

/** Builds the index object from plugin ZIPs. */
export function generateIndex(artifacts: Artifact[], config: RepoConfig = {}) {
	const plugins: Record<
		string,
		IndexPlugin & { _newest: Version; _manifest: Manifest }
	> = {}

	for (const artifact of artifacts) {
		const bytes = readFileSync(artifact.file)
		const manifestBytes = readZipEntry(bytes, 'manifest.json')
		if (!manifestBytes)
			throw new Error(`${artifact.file}: no manifest.json in ZIP`)

		const manifest = JSON.parse(
			new TextDecoder().decode(manifestBytes),
		) as Manifest
		validateManifest(manifest, artifact.file)
		const version = parseVersion(manifest.version)

		const claimed = parsePoolFileName(basename(artifact.file))
		if (
			claimed &&
			(claimed.id !== manifest.id || claimed.version !== manifest.version)
		)
			throw new Error(
				`${artifact.file}: named ${claimed.id}@${claimed.version}, but holds ${manifest.id}@${manifest.version}`,
			)

		const entry: IndexVersion = {
			url: artifact.url,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			size: bytes.length,
			dependencies: Object.fromEntries(
				Object.entries(manifest.dependencies ?? {}).map(([depId, dep]) => [
					depId,
					{ version: dep.version, optional: dep.optional },
				]),
			),
		}

		const existing = plugins[manifest.id]
		if (existing) {
			if (manifest.version in existing.versions)
				throw new Error(`Duplicate version ${manifest.id}@${manifest.version}`)
			existing.versions[manifest.version] = entry
			// Display metadata follows the newest version's manifest.
			if (compareVersionsFull(version, existing._newest) > 0) {
				existing._newest = version
				existing._manifest = manifest
			}
		} else {
			plugins[manifest.id] = {
				name: manifest.name,
				description: manifest.description ?? '',
				author: manifest.author ?? '',
				...(manifest.contributors?.length
					? { contributors: manifest.contributors }
					: {}),
				...(manifest.icon ? { icon: manifest.icon } : {}),
				channels: {},
				versions: { [manifest.version]: entry },
				_newest: version,
				_manifest: manifest,
			}
		}
	}

	// Channel pointers + display metadata finalization.
	const output: Record<string, IndexPlugin> = {}
	for (const [id, plugin] of Object.entries(plugins)) {
		const versions = Object.keys(plugin.versions).map(
			v => [v, parseVersion(v)] as const,
		)
		const newest = (candidates: (readonly [string, Version])[]) =>
			candidates.reduce((best, cur) =>
				compareVersionsFull(cur[1], best[1]) > 0 ? cur : best,
			)

		const channels: Record<string, string> = {}
		const nonLabeled = versions.filter(([, v]) => v.label === null)
		if (nonLabeled.length) channels.latest = newest(nonLabeled)[0]
		const overall = newest(versions)[0]
		if (overall !== channels.latest) channels.beta = overall

		// Prioritize `repo.config.json` overrides pointing at published versions.
		for (const [channel, target] of Object.entries(
			config.channels?.[id] ?? {},
		)) {
			if (!(target in plugin.versions))
				throw new Error(
					`Channel override ${id}/${channel} points at unpublished version '${target}'`,
				)
			channels[channel] = target
		}

		const manifest = plugin._manifest
		output[id] = {
			name: manifest.name,
			description: manifest.description ?? '',
			author: manifest.author ?? '',
			...(manifest.contributors?.length
				? { contributors: manifest.contributors }
				: {}),
			...(manifest.icon ? { icon: manifest.icon } : {}),
			channels,
			versions: plugin.versions,
		}
	}

	const index = {
		format: INDEX_FORMAT,
		name: config.name ?? 'Plugin Repository',
		description: config.description ?? '',
		...(config.icon ? { icon: config.icon } : {}),
		plugins: output,
	}

	return index
}
