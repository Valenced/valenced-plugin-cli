const USAGE = `Usage: valenced-plugin <command> [options]

Commands:
  build [names...] [--dev]        Bundle every (or the named) plugin's JS
  generate-index [options]        Write a repository index.json from plugin ZIPs
  plan-releases [options]         List the plugins whose manifest version is not yet released
  serve [options]                 Serve a local repository (index + ZIPs) for device testing

Run against a plugin repo root (the directory containing plugins/).
Pass --plugins-dir more than once to use several plugin directories.
See each command's --help for its options.`

const [command, ...argv] = process.argv.slice(2)

async function dispatch(
	load: () => Promise<{ run(argv: string[]): Promise<void> }>,
) {
	try {
		await (await load()).run(argv)
	} catch (e) {
		console.error(`Error: ${e instanceof Error ? e.message : e}`)
		process.exitCode = 1
	}
}

switch (command) {
	case 'build':
		await dispatch(() => import('./build.ts'))
		break
	case 'generate-index':
		await dispatch(() => import('./generate-index.ts'))
		break
	case 'plan-releases':
		await dispatch(() => import('./plan-releases.ts'))
		break
	case 'serve':
		await dispatch(() => import('./serve.ts'))
		break
	case undefined:
	case 'help':
	case '--help':
	case '-h':
		console.log(USAGE)
		if (command === undefined) process.exitCode = 1
		break
	default:
		console.error(`Unknown command: ${command}\n\n${USAGE}`)
		process.exitCode = 1
}
