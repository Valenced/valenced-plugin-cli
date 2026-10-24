import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import {
	collectArtifacts,
	compareVersionsFull,
	generateIndex,
	newestVersion,
	parsePoolFileName,
	parseVersion,
	poolFileName,
} from '../src/generate-index.ts'
import {
	planReleases,
	readPluginSources,
	readPooledVersions,
} from '../src/plan-releases.ts'
import type { PluginSource } from '../src/plan-releases.ts'

const order = (a: string, b: string) =>
	compareVersionsFull(parseVersion(a), parseVersion(b))

describe('Version total order', () => {
	test('compares the integers first, right padding the shorter one', () => {
		expect(order('1.3.0', '1.2.9')).toBeGreaterThan(0)
		expect(order('1.2', '1.2.0')).toBe(0)
		expect(order('355.0', '356.0')).toBeLessThan(0)
	})

	test('sorts a bare version above a labeled one', () => {
		// `sort -V` disagrees, which is why the shell must not decide this.
		expect(order('1.2.0', '1.2.0-rc')).toBeGreaterThan(0)
		expect(order('1.0.0-beta', '1.0.0')).toBeLessThan(0)
	})

	test('compares label digit runs numerically', () => {
		expect(order('1.0.0-rc2', '1.0.0-rc10')).toBeLessThan(0)
		expect(order('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
		expect(order('1.0.0-rc', '1.0.0-rc1')).toBeLessThan(0)
		expect(order('1.0.0-rc3', '1.0.0-rc3')).toBe(0)
	})

	test('picks the newest of a version list', () => {
		expect(newestVersion([])).toBeNull()
		expect(newestVersion(['1.2.0-rc', '1.2.0', '1.1.9'])).toBe('1.2.0')
		expect(newestVersion(['1.2.0', '1.3.0-rc'])).toBe('1.3.0-rc')
	})
})

describe('Release planning', () => {
	const plugin = (version: string, name = 'demo'): PluginSource[] => [
		{ name, id: `com.example.${name}`, version },
	]

	test('plans a release for a version the pool does not hold', () => {
		expect(planReleases(plugin('1.1.0'), () => ['1.0.0'])).toEqual([
			{
				name: 'demo',
				id: 'com.example.demo',
				version: '1.1.0',
				tag: 'demo@1.1.0',
				zip: 'build/dist/com.example.demo@1.1.0.zip',
				file: 'com.example.demo@1.1.0.zip',
			},
		])
	})

	test('skips a version the pool already holds', () => {
		expect(planReleases(plugin('1.0.0'), () => ['1.0.0'])).toEqual([])
	})

	test('promotes a prerelease to its stable version', () => {
		// The `sort -V` guard rejected this, blocking every rc to stable release.
		const plan = planReleases(plugin('1.2.0'), () => ['1.2.0-rc'])
		expect(plan.map(release => release.tag)).toEqual(['demo@1.2.0'])
	})

	test('rejects a version below the newest published one', () => {
		expect(() => planReleases(plugin('1.0.0'), () => ['1.1.0'])).toThrow(
			'demo: manifest version 1.0.0 is below published 1.1.0',
		)
		// A label is always a prerelease, so this goes backwards too.
		expect(() => planReleases(plugin('1.1.0-rc'), () => ['1.1.0'])).toThrow(
			'demo: manifest version 1.1.0-rc is below published 1.1.0',
		)
	})

	test('rejects a version the grammar does not allow', () => {
		expect(() => planReleases(plugin('1.0.0-RC'), () => [])).toThrow(
			"demo: invalid version '1.0.0-RC'",
		)
		expect(() => planReleases(plugin('v1.0.0'), () => [])).toThrow(
			"demo: invalid version 'v1.0.0'",
		)
	})

	test('plans every plugin in name order, against its own history', () => {
		const published: Record<string, string[]> = {
			'com.example.alpha': ['1.0.0'],
			'com.example.beta': [],
		}
		const plan = planReleases(
			[...plugin('2.0.0', 'beta'), ...plugin('1.1.0', 'alpha')],
			id => published[id] ?? [],
		)
		expect(plan.map(release => release.tag)).toEqual([
			'alpha@1.1.0',
			'beta@2.0.0',
		])
	})

	test('keys history by id, so renaming the folder keeps it', () => {
		// The folder is `renamed`, the id is not, and 1.1.0 is already published.
		const published = { 'com.example.demo': ['1.1.0'] } as Record<
			string,
			string[]
		>
		const sources: PluginSource[] = [
			{ name: 'renamed', id: 'com.example.demo', version: '1.0.0' },
		]
		expect(() => planReleases(sources, id => published[id] ?? [])).toThrow(
			'renamed: manifest version 1.0.0 is below published 1.1.0',
		)
	})

	test('points at the artifact the build produces', () => {
		const [release] = planReleases(plugin('1.0.0'), () => [], 'out/zips')
		expect(release?.zip).toBe('out/zips/com.example.demo@1.0.0.zip')
	})
})

// ---------------------------------------------------------------------------
// The pool is the ledger: an artifact exists, or the version is unpublished.
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'valenced-pool-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let poolCount = 0
function emptyPool(): string {
	const dir = join(scratch, `pool-${poolCount++}`)
	mkdirSync(dir, { recursive: true })
	return dir
}

function writeArtifact(
	dir: string,
	fileName: string,
	id: string,
	version: string,
): string {
	const manifest = {
		format: 1,
		id,
		name: 'Demo',
		version,
		dependencies: { 'valenced.api': { version: '>=1.0.0' }, discord: {} },
	}
	const path = join(dir, fileName)
	writeFileSync(
		path,
		zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) }),
	)
	return path
}

describe('Pool file names', () => {
	test('joins and splits on a character neither half can hold', () => {
		expect(poolFileName('com.example.demo', '1.2.0-rc2')).toBe(
			'com.example.demo@1.2.0-rc2.zip',
		)
		expect(parsePoolFileName('com.example.demo@1.2.0-rc2.zip')).toEqual({
			id: 'com.example.demo',
			version: '1.2.0-rc2',
		})
	})

	test('rejects a name that is not one', () => {
		expect(parsePoolFileName('com.example.demo.zip')).toBeNull()
		expect(parsePoolFileName('com.example.demo@1.0.0')).toBeNull()
		expect(parsePoolFileName('com.example.demo@1.0.0@extra.zip')).toBeNull()
		expect(parsePoolFileName('com.example.demo@v1.0.0.zip')).toBeNull()
		expect(parsePoolFileName('bad id@1.0.0.zip')).toBeNull()
	})
})

describe('Pool ledger', () => {
	test('groups published versions by id', () => {
		const dir = emptyPool()
		writeArtifact(dir, 'com.example.demo@1.0.0.zip', 'com.example.demo', '1.0.0')
		writeArtifact(dir, 'com.example.demo@1.1.0.zip', 'com.example.demo', '1.1.0')
		writeArtifact(dir, 'com.example.other@2.0.0.zip', 'com.example.other', '2.0.0')
		writeFileSync(join(dir, 'README.md'), 'not an artifact\n')

		const released = readPooledVersions(dir)
		expect(released.get('com.example.demo')?.sort()).toEqual(['1.0.0', '1.1.0'])
		expect(released.get('com.example.other')).toEqual(['2.0.0'])
	})

	test('reports a ZIP that does not name its version', () => {
		// Skipping it would hide a published version and let a later release collide.
		const dir = emptyPool()
		writeArtifact(dir, 'com.example.demo.zip', 'com.example.demo', '1.0.0')
		expect(() => readPooledVersions(dir)).toThrow(
			"com.example.demo.zip: not an '<id>@<version>.zip' artifact",
		)
	})

	test('refuses to treat an absent pool as an empty one', () => {
		expect(() => readPooledVersions(join(scratch, 'never-checked-out'))).toThrow(
			'Check out the published branch first',
		)
	})

	test('an empty pool publishes everything, which is the initial state', () => {
		expect(readPooledVersions(emptyPool()).size).toBe(0)
	})
})

describe('Pool integrity', () => {
	const artifacts = (path: string) => [
		{ file: path, url: `https://example.invalid/pool/${path.split('/').pop()}` },
	]

	test('indexes an artifact whose name matches its manifest', () => {
		const dir = emptyPool()
		const path = writeArtifact(
			dir,
			'com.example.demo@1.0.0.zip',
			'com.example.demo',
			'1.0.0',
		)
		const index = generateIndex(artifacts(path))
		expect(Object.keys(index.plugins['com.example.demo']?.versions ?? {})).toEqual(
			['1.0.0'],
		)
	})

	test('reports a name that disagrees with the manifest inside', () => {
		// Otherwise the index serves 1.0.0 at the URL that claims 2.0.0.
		const dir = emptyPool()
		const path = writeArtifact(
			dir,
			'com.example.demo@2.0.0.zip',
			'com.example.demo',
			'1.0.0',
		)
		expect(() => generateIndex(artifacts(path))).toThrow(
			'named com.example.demo@2.0.0, but holds com.example.demo@1.0.0',
		)
	})

	test('reports an artifact the pool cannot name', () => {
		// The index would serve it while the planner, which reads names, could not see it.
		const dir = emptyPool()
		writeArtifact(dir, 'plain.zip', 'com.example.demo', '1.0.0')
		expect(() =>
			collectArtifacts({ dist: dir, baseUrl: 'https://example.invalid/pool' }),
		).toThrow('artifacts must be named <id>@<version>.zip')
	})

	test('takes an artifact the pool can name', () => {
		const dir = emptyPool()
		writeArtifact(dir, 'com.example.demo@1.0.0.zip', 'com.example.demo', '1.0.0')
		expect(
			collectArtifacts({ dist: dir, baseUrl: 'https://example.invalid/pool' }),
		).toEqual([
			{
				file: `${dir}/com.example.demo@1.0.0.zip`,
				url: 'https://example.invalid/pool/com.example.demo@1.0.0.zip',
			},
		])
	})
})

describe('Plugin sources', () => {
	const writePlugin = (root: string, name: string, id: string) => {
		mkdirSync(join(root, name), { recursive: true })
		writeFileSync(
			join(root, name, 'manifest.json'),
			JSON.stringify({ id, version: '1.0.0' }),
		)
	}

	test('reads every plugins directory', () => {
		const plugins = join(scratch, 'sources', 'plugins')
		const themes = join(scratch, 'sources', 'themes')
		writePlugin(plugins, 'demo', 'com.example.demo')
		writePlugin(themes, 'midnight', 'com.example.midnight')
		expect(readPluginSources([plugins, themes]).map(s => s.id)).toEqual([
			'com.example.demo',
			'com.example.midnight',
		])
	})

	test('reports a missing plugins directory', () => {
		expect(() => readPluginSources([join(scratch, 'absent')])).toThrow(
			'No plugins directory',
		)
	})
})
