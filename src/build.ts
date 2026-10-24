import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseArgs } from 'node:util'
import hiddenImportMap from '@valenced/types/modules.hidden.importmap.json' with { type: 'json'
}
import hiddenModules from '@valenced/types/modules.hidden.json' with { type: 'json'
}
import publicImportMap from '@valenced/types/modules.importmap.json' with { type: 'json'
}
import modules from '@valenced/types/modules.json' with { type: 'json' }
import { parseSync, transform as swcTransform } from '@swc/core'
import { rolldown } from 'rolldown'
import type { Module } from '@swc/core'

/**
 * How the global holding a module relates to the module itself.
 *
 * - `namespace`: the global is the module namespace. A default import reads `.default`.
 * - `default`: the global IS the default export. A namespace import cannot be expressed.
 * - `cjs`: the global is a CommonJS `module.exports`. A default import reads the global itself.
 */
type Interop = 'namespace' | 'default' | 'cjs'

interface ExternalTarget {
	global: string
	interop: Interop
}

type ImportMapEntry = string | { global: string; interop?: 'default' }

const GlobalImportAliases: Record<string, string> = {
	react: 'valenced.react.React',
	'react-native': 'valenced.react.ReactNative',
	'react/jsx-runtime': 'valenced.react.ReactJSXRuntime',
	'react/jsx-dev-runtime': 'valenced.react.ReactJSXRuntime',
	'zustand': 'valenced.externals.Zustand.Zustand',
	'zustand/vanilla': 'valenced.externals.Zustand.ZustandVanilla',
	'zustand/react': 'valenced.externals.Zustand.ZustandReact',
	'@shopify/flash-list': 'valenced.externals.Shopify.FlashList',
	'@react-native-clipboard/clipboard':
		'valenced.externals.ReactNativeClipboard.Clipboard',
	'@react-navigation/stack':
		'valenced.externals.ReactNavigation.ReactNavigationStack',
	'@react-navigation/native':
		'valenced.externals.ReactNavigation.ReactNavigationNative',
}

const ImportMap = {
	...publicImportMap,
	...hiddenImportMap,
} as Record<string, ImportMapEntry>

const TypeOnlyModules = new Set(
	[...modules, ...hiddenModules]
		.map(mod => `@valenced/${mod}`)
		.filter(id => !(id in ImportMap)),
)

function isExternal(id: string): boolean {
	if (id in GlobalImportAliases) return true

	return id in ImportMap || TypeOnlyModules.has(id)
}

/** Resolves a module to the global path. Returns `null` for a type-only module. */
function resolveExternal(id: string): ExternalTarget | null {
	if (id in GlobalImportAliases) {
		return { global: GlobalImportAliases[id]!, interop: 'cjs' }
	}

	const entry = ImportMap[id]
	if (entry) {
		return typeof entry === 'string'
			? { global: entry, interop: 'namespace' }
			: { global: entry.global, interop: entry.interop ?? 'namespace' }
	}

	if (TypeOnlyModules.has(id)) return null
	throw new Error(
		`Import cannot be resolved: ${id}\n\nCheck if the module is installed or @valenced/types is up to date`,
	)
}

/**
 * Rolldown plugin that uses SWC to transpile code using Valenced's exact Hermes SWC settings:
 * https://github.com/facebook/hermes/blob/main/doc/Features.md
 */
const hermesSwcPlugin = {
	name: 'hermes-swc',
	async transform(code: string, id: string) {
		if (!/\.[jt]sx?$/.test(id) || id.includes('node_modules')) return null

		const ext = extname(id)
		const ts = ext.includes('ts')
		const tsx = ts ? ext.endsWith('x') : false
		const jsx = !ts ? ext.endsWith('x') : false

		const result = await swcTransform(code, {
			filename: id,
			jsc: {
				transform: {
					react: {
						runtime: 'automatic',
					},
				},
				parser: {
					syntax: ts ? 'typescript' : 'ecmascript',
					tsx,
					jsx,
				},
			},
			env: {
				targets: 'fully supports es6',
				include: [
					'transform-arrow-functions',
					'transform-async-generator-functions',
					'transform-block-scoping',
					'transform-classes',
					'transform-duplicate-named-capturing-groups-regex',
					'transform-named-capturing-groups-regex',
				],
				exclude: [
					'transform-async-to-generator',
					'transform-exponentiation-operator',
					'transform-logical-assignment-operators',
					'transform-nullish-coalescing-operator',
					'transform-numeric-separator',
					'transform-object-rest-spread',
					'transform-optional-catch-binding',
					'transform-optional-chaining',
					'transform-parameters',
					'transform-template-literals',
				],
			},
		})

		return {
			code: result.code,
			map: result.map ?? null,
		}
	},
}

/**
 * Asset loader plugin that converts imported files into exports:
 * - Raw (.json): default export object
 * - Images (.png, .jpg, .jpeg, .webp, .svg): default export base64 data URI string
 */
export const fileParserPlugin = {
	name: 'file-parser',
	async load(id: string) {
		const parsers: Record<string, string[]> = {
			raw: ['json'],
			uri: ['png', 'jpg', 'jpeg', 'webp', 'svg'],
		}
		const extToMime: Record<string, string> = {
			png: 'image/png',
			jpg: 'image/jpeg',
			jpeg: 'image/jpeg',
			webp: 'image/webp',
			svg: 'image/svg+xml',
		}

		const ext = extname(id).slice(1).toLowerCase()
		const mode = Object.entries(parsers).find(([_, exts]) =>
			exts.includes(ext),
		)?.[0]
		if (!mode) return null

		let exportedContent: string
		if (mode === 'text') {
			const text = await readFile(id, 'utf8')
			exportedContent = JSON.stringify(text)
		} else if (mode === 'raw') {
			exportedContent = await readFile(id, 'utf8')
		} else if (mode === 'uri') {
			const buf = await readFile(id)
			const mime = extToMime[ext] ?? 'application/octet-stream'
			exportedContent = JSON.stringify(
				`data:${mime};base64,${buf.toString('base64')}`,
			)
		} else {
			return null
		}

		return {
			code: `export default ${exportedContent};`,
			// Rolldown infers the module type from the extension, so without this it parses the .json output as JSON.
			moduleType: 'js' as const,
			map: null,
		}
	},
}

/**
 * AST node types where an Identifier represents a pattern, declaration, or type definition,
 * rather than an expression value access.
 */
const DECLARATION_AND_PATTERN_TYPES = new Set([
	'VariableDeclarator',
	'FunctionDeclaration',
	'FunctionExpression',
	'ClassDeclaration',
	'ClassExpression',
	'Parameter',
	'FormalParameter',
	'RestElement',
	'CatchClause',
	'ObjectPattern',
	'ArrayPattern',
	'AssignmentPattern',
	'AssignmentPatternProperty',
	'BindingProperty',
	'KeyedBindingProperty',
	'Property',
	'KeyValueProperty',
	'ClassProperty',
	'PrivateProperty',
	'ClassMethod',
	'PrivateMethod',
	'MethodDefinition',
	'ExportSpecifier',
	'ExportDefaultSpecifier',
	'ExportNamespaceSpecifier',
	'ExportNamedDeclaration',
	'ImportSpecifier',
	'ImportDefaultSpecifier',
	'ImportNamespaceSpecifier',
	'ImportDeclaration',
	'JSXAttribute',
	'TsTypeReference',
	'TsTypeAnnotation',
	'TsInterfaceDeclaration',
	'TsTypeAliasDeclaration',
	'TsEnumDeclaration',
	'TsEnumMember',
	'TsTypeParameter',
	'TsTypeParameterDeclaration',
	'TsTypeParameterInstantiation',
	'TsPropertySignature',
	'TsMethodSignature',
	'TsIndexSignature',
	'TsGetterSignature',
	'TsSetterSignature',
	'TsNamespaceDeclaration',
	'TsModuleDeclaration',
])

interface TextEdit {
	start: number
	end: number
	replacement: string
}

function isExpressionIdentifier(
	_node: any,
	parent: any,
	parentKey: any,
): boolean {
	if (!parent) return true

	if (
		parent.type === 'MemberExpression' &&
		parentKey === 'property' &&
		!parent.computed
	) {
		return false
	}
	if (parent.type === 'VariableDeclarator') {
		return parentKey !== 'id'
	}
	if (
		parent.type === 'FunctionDeclaration' ||
		parent.type === 'FunctionExpression' ||
		parent.type === 'ClassDeclaration' ||
		parent.type === 'ClassExpression'
	) {
		return parentKey !== 'id'
	}
	if (
		(parent.type === 'KeyValueProperty' ||
			parent.type === 'Property' ||
			parent.type === 'KeyValuePatternProperty') &&
		parentKey === 'key' &&
		!parent.computed
	) {
		return false
	}
	if (
		(parent.type === 'ClassProperty' ||
			parent.type === 'PrivateProperty' ||
			parent.type === 'ClassMethod' ||
			parent.type === 'PrivateMethod' ||
			parent.type === 'MethodDefinition') &&
		parentKey === 'key'
	) {
		return false
	}
	if (parent.type === 'AssignmentExpression') {
		return parentKey !== 'left'
	}
	if (parent.type === 'CatchClause' && parentKey === 'param') {
		return false
	}
	if (parent.type === 'JSXAttribute' && parentKey === 'name') {
		return false
	}
	return !DECLARATION_AND_PATTERN_TYPES.has(parent.type)
}

function extractImportedSymbols(
	ast: Module,
	edits: TextEdit[],
	_buf: Buffer,
): {
	symbolMap: Map<string, string>
	addEdit: (start: number, end: number, replacement: string) => void
} {
	const symbolMap = new Map<string, string>()

	for (const node of ast.body) {
		if (node.type !== 'ImportDeclaration') continue

		const source = node.source.value
		if (!isExternal(source) || source.startsWith('react/jsx')) continue

		if (node.typeOnly) continue

		const valueSpecifiers = (node.specifiers ?? []).filter(
			spec => !(spec.type === 'ImportSpecifier' && spec.isTypeOnly),
		)
		if (valueSpecifiers.length === 0) continue

		const target = resolveExternal(source)
		if (!target) continue

		for (const spec of valueSpecifiers) {
			if (spec.type === 'ImportDefaultSpecifier') {
				// A `default` or `cjs` global already IS the default export.
				symbolMap.set(
					spec.local.value,
					target.interop === 'namespace'
						? `${target.global}.default`
						: target.global,
				)
			} else if (spec.type === 'ImportNamespaceSpecifier') {
				if (target.interop === 'default') {
					throw new Error(
						`${source} exposes its default export as \`${target.global}\`, so it has no namespace. Import the default instead of \`* as ${spec.local.value}\`.`,
					)
				}
				symbolMap.set(spec.local.value, target.global)
			} else if (spec.type === 'ImportSpecifier') {
				const imported = spec.imported ? spec.imported.value : spec.local.value
				if (target.interop === 'default' && imported !== 'default') {
					throw new Error(
						`${source} exposes its default export as \`${target.global}\`, so \`${imported}\` is not readable at runtime.`,
					)
				}
				symbolMap.set(
					spec.local.value,
					target.interop === 'default'
						? target.global
						: `${target.global}.${imported}`,
				)
			}
		}
	}

	const processedSpans = new Set<string>()
	function addEdit(start: number, end: number, replacement: string) {
		const key = `${start}:${end}:${replacement}`
		if (processedSpans.has(key)) return
		processedSpans.add(key)
		edits.push({ start, end, replacement })
	}

	// Automatically resolve top-level destructuring/assignment aliases from imported symbols
	let expanded = true
	while (expanded) {
		expanded = false
		for (const node of ast.body) {
			if (node.type !== 'VariableDeclaration') continue

			let allImportDerived = true
			for (const decl of node.declarations) {
				if (!decl.init) {
					allImportDerived = false
					continue
				}

				let baseTarget: string | null = null
				if (decl.init.type === 'Identifier' && symbolMap.has(decl.init.value)) {
					baseTarget = symbolMap.get(decl.init.value)!
				} else if (
					decl.init.type === 'MemberExpression' &&
					decl.init.object.type === 'Identifier' &&
					decl.init.property.type === 'Identifier' &&
					symbolMap.has(decl.init.object.value)
				) {
					const baseObj = symbolMap.get(decl.init.object.value)!
					const propName = decl.init.property.value
					baseTarget = `${baseObj}.${propName}`
				}

				if (!baseTarget) {
					allImportDerived = false
					continue
				}

				if (decl.id.type === 'ObjectPattern') {
					for (const prop of decl.id.properties) {
						if (prop.type === 'AssignmentPatternProperty') {
							const name = prop.key.value
							if (!symbolMap.has(name)) {
								symbolMap.set(name, `${baseTarget}.${name}`)
								expanded = true
							}
						} else if (
							prop.type === 'KeyValuePatternProperty' &&
							prop.key.type === 'Identifier' &&
							prop.value.type === 'Identifier'
						) {
							const key = prop.key.value
							const value = prop.value.value
							if (!symbolMap.has(value)) {
								symbolMap.set(value, `${baseTarget}.${key}`)
								expanded = true
							}
						}
					}
				} else if (decl.id.type === 'Identifier') {
					const name = decl.id.value
					if (!symbolMap.has(name)) {
						symbolMap.set(name, baseTarget)
						expanded = true
					}
				}
			}

			if (allImportDerived) {
				addEdit(node.span.start - 1, node.span.end - 1, '')
			}
		}
	}

	return { symbolMap, addEdit }
}

function isPureReadExpression(node: any): boolean {
	if (!node) return false
	if (node.type === 'Identifier') return true
	if (node.type === 'MemberExpression') {
		if (node.computed) {
			return (
				isPureReadExpression(node.object) && isPureReadExpression(node.property)
			)
		}
		return isPureReadExpression(node.object)
	}
	return false
}

function collectIdentifierEdits(
	ast: Module,
	symbolMap: Map<string, string>,
	addEdit: (start: number, end: number, replacement: string) => void,
): void {
	function traverse(node: any, parent: any, parentKey: any) {
		if (!node || typeof node !== 'object') return
		if (node.type === 'ImportDeclaration') {
			if (
				isExternal(node.source.value) &&
				!node.source.value.startsWith('react/jsx')
			) {
				addEdit(node.span.start - 1, node.span.end - 1, '')
			}
			return
		}

		if (node.type === 'ExpressionStatement') {
			if (isPureReadExpression(node.expression)) {
				addEdit(node.span.start - 1, node.span.end - 1, '')
				return
			}
			if (node.expression && node.expression.type === 'SequenceExpression') {
				const exprs = node.expression.expressions
				for (let i = 0; i < exprs.length; i++) {
					const childExpr = exprs[i]
					if (isPureReadExpression(childExpr)) {
						const start = childExpr.span.start - 1
						const end = childExpr.span.end - 1
						if (i > 0) {
							const prevEnd = exprs[i - 1].span.end - 1
							addEdit(prevEnd, end, '')
						} else if (i < exprs.length - 1) {
							const nextStart = exprs[i + 1].span.start - 1
							addEdit(start, nextStart, '')
						} else {
							addEdit(node.span.start - 1, node.span.end - 1, '')
						}
					}
				}
			}
		}

		if (node.type === 'Identifier' && symbolMap.has(node.value) && node.span) {
			if (isExpressionIdentifier(node, parent, parentKey)) {
				addEdit(
					node.span.start - 1,
					node.span.end - 1,
					symbolMap.get(node.value)!,
				)
			}
			return
		}

		for (const key of Object.keys(node)) {
			if (key === 'span' || key === 'ctxt') continue
			const child = node[key]
			if (Array.isArray(child)) {
				for (let i = 0; i < child.length; i++) {
					traverse(child[i], node, i)
				}
			} else if (child && typeof child === 'object') {
				traverse(child, node, key)
			}
		}
	}

	traverse(ast, null, null)
}

function applyEditsToBuffer(code: string, edits: TextEdit[]): string {
	// Get the outermost non-overlapping edits
	const ordered = [...edits].sort((a, b) => a.start - b.start || b.end - a.end)
	const applicable: TextEdit[] = []
	let coveredUntil = -1
	for (const edit of ordered) {
		if (edit.start < coveredUntil) continue
		applicable.push(edit)
		coveredUntil = edit.end
	}

	let buf = Buffer.from(code, 'utf8')
	for (let i = applicable.length - 1; i >= 0; i--) {
		const { start, end, replacement } = applicable[i]!
		buf = Buffer.concat([
			buf.subarray(0, start),
			Buffer.from(replacement, 'utf8'),
			buf.subarray(end),
		])
	}

	return buf.toString('utf8')
}

/**
 * Rewrites one module: external imports are erased and every use of an imported symbol becomes a property access on `valenced`.
 * Returns `null` when the module imports nothing external.
 */
export function inlineExternalImports(code: string, id: string): string | null {
	if (!/\.[jt]sx?$/.test(id) || id.includes('node_modules')) return null

	const isTs = id.endsWith('.ts') || id.endsWith('.tsx')
	const isJsx = id.endsWith('.tsx') || id.endsWith('.jsx')

	let ast: Module
	try {
		ast = parseSync(code, {
			syntax: isTs ? 'typescript' : 'ecmascript',
			tsx: isJsx,
			jsx: isJsx,
		})
	} catch {
		return null
	}

	const edits: TextEdit[] = []
	const buf = Buffer.from(code, 'utf8')
	const { symbolMap, addEdit } = extractImportedSymbols(ast, edits, buf)
	if (symbolMap.size === 0) return null

	collectIdentifierEdits(ast, symbolMap, addEdit)
	if (edits.length === 0) return null

	return applyEditsToBuffer(code, edits)
}

/**
 * Rolldown plugin that uses SWC AST parsing to inline external module imports (`@valenced/*`, `react`, `react-native`)
 * directly into global property accesses on `valenced` at usage sites inside functions/components.
 *
 * This avoids any top-level variable binding or preInit property evaluation issues.
 */
const inlineImportsPlugin = {
	name: 'inline-imports',
	transform(code: string, id: string) {
		const transformed = inlineExternalImports(code, id)
		if (transformed === null) return null

		return {
			code: transformed,
			map: null,
		}
	},
}

const ENTRY_CANDIDATES = [
	'js/index.ts',
	'js/index.tsx',
	'js/index.js',
	'js/index.jsx',
	'src/index.ts',
	'src/index.tsx',
	'src/index.js',
	'src/index.jsx',
	'index.ts',
	'index.tsx',
	'index.js',
	'index.jsx',
]

function cleanupBundleCode(code: string): string {
	try {
		const ast = parseSync(code, { syntax: 'ecmascript' })
		const edits: TextEdit[] = []
		function visit(node: any) {
			if (!node || typeof node !== 'object') return
			if (node.type === 'ExpressionStatement') {
				if (isPureReadExpression(node.expression)) {
					edits.push({
						start: node.span.start - 1,
						end: node.span.end - 1,
						replacement: '',
					})
					return
				}
				if (node.expression && node.expression.type === 'SequenceExpression') {
					const exprs = node.expression.expressions
					for (let i = 0; i < exprs.length; i++) {
						const childExpr = exprs[i]
						if (isPureReadExpression(childExpr)) {
							const start = childExpr.span.start - 1
							const end = childExpr.span.end - 1
							if (i > 0) {
								const prevEnd = exprs[i - 1].span.end - 1
								edits.push({
									start: prevEnd,
									end,
									replacement: '',
								})
							} else if (i < exprs.length - 1) {
								const nextStart = exprs[i + 1].span.start - 1
								edits.push({
									start,
									end: nextStart,
									replacement: '',
								})
							} else {
								edits.push({
									start: node.span.start - 1,
									end: node.span.end - 1,
									replacement: '',
								})
							}
						}
					}
				}
			}
			for (const key of Object.keys(node)) {
				if (key === 'span' || key === 'ctxt') continue
				const child = node[key]
				if (Array.isArray(child)) {
					for (const c of child) visit(c)
				} else if (child && typeof child === 'object') {
					visit(child)
				}
			}
		}

		visit(ast)
		if (edits.length > 0) {
			return applyEditsToBuffer(code, edits)
		}
	} catch {}
	return code
}

export async function run(argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			dev: { type: 'boolean', short: 'd', default: false },
			'plugins-dir': { type: 'string', multiple: true, default: ['plugins'] },
			help: { type: 'boolean', short: 'h', default: false },
		},
	})
	if (values.help) {
		console.log(`Usage: valenced-plugin build [names...] [--dev] [--plugins-dir <dir>]...

Bundles each plugin's index.{ts,tsx,js,jsx} (in the plugin root or js/) into
<plugin>/build/js/index.js. Positional names select specific plugins; otherwise
every plugin is built. Repeat --plugins-dir to build from several directories.`)
		return
	}

	const dev = values.dev
	const dirs = values['plugins-dir'].flatMap(pluginsDir =>
		(positionals.length ? positionals : readdirSync(pluginsDir)).map(
			name => ({ name, dir: `${pluginsDir}/${name}` }),
		),
	)

	for (const { name, dir } of dirs) {
		const manifestPath = `${dir}/manifest.json`
		if (!existsSync(manifestPath)) continue

		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
		const script: string | undefined = manifest.dist?.script
		if (!script) continue // No JS portion.

		const entry = ENTRY_CANDIDATES.map(c => `${dir}/${c}`).find(existsSync)
		if (!entry) {
			console.warn(
				`! ${name}: dist.script is set but no index.{ts,tsx,js,jsx} found; skipping JS`,
			)
			continue
		}

		try {
			const bundle = await rolldown({
				input: entry,
				platform: 'neutral',
				external: isExternal,
				plugins: [fileParserPlugin, inlineImportsPlugin, hermesSwcPlugin],
				resolve: {
					mainFields: ['module', 'main'],
					extensions: [
						'.tsx',
						'.ts',
						'.jsx',
						'.js',
						'.mjs',
						'.cjs',
						'.json',
						'.png',
						'.jpg',
						'.jpeg',
						'.webp',
						'.svg',
					],
				},
				transform: {
					target: 'es2020',
					jsx: {
						// Compiles to `react/jsx-runtime` imports, which remaps to `valenced.react.ReactJSXRuntime`.
						runtime: 'automatic',
						// We don't expose jsxDev
						development: false,
					},
					define: {
						__DEV__: String(dev),
						IS_DEV: String(dev),
					},
				},
				onwarn(warning, warn) {
					if (warning.code === 'MISSING_NAME_OPTION_FOR_IIFE_EXPORT') return
					if (warning.code === 'MIXED_EXPORTS') return
					// Plugins set `jsx: "preserve"` so TSC only typechecks and the bundler transforms.
					// Setting it here (rather than inheriting tsconfig) keeps outputs deterministic, so the "overridden" notice is expected.
					if (
						warning.code === 'CONFIGURATION_FIELD_CONFLICT' &&
						warning.message.includes('jsx')
					)
						return

					warn(warning)
				},
			})

			const { output } = await bundle.generate({
				format: 'iife',
				globals: id => {
					const target = resolveExternal(id)
					if (!target)
						throw new Error(`${id} holds types only and has no global.`)

					return target.global
				},
				exports: 'named',
				esModule: false,
				minify: dev ? 'dce-only' : true,
			})
			await bundle.close()

			const chunk = output[0]!
			if (!chunk.exports.length)
				throw new Error(
					`${entry} has no default export. A plugin must have an entrypoint:\n` +
						'`export default plugin({ ... })`.',
				)

			const outDir = `${dir}/build/js`
			await mkdir(outDir, { recursive: true })
			const outCode = cleanupBundleCode(chunk.code)
			await writeFile(`${outDir}/index.js`, outCode, 'utf8')

			console.log(`\u2713 Built JS for ${manifest.id ?? name}`)
		} catch (e) {
			console.error(`\u2717 Failed to build JS for ${name}:`, e)
			process.exitCode = 1
		}
	}
}
