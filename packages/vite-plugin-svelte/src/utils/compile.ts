import { CompileOptions, Processed, ResolvedOptions } from './options'
import { compile, preprocess, walk } from 'svelte/compiler'
// @ts-ignore
import { createMakeHot } from 'svelte-hmr'
import { SvelteRequest } from './id'
import { safeBase64Hash } from './hash'
import { log } from './log'

const _createCompileSvelte = (makeHot: Function) => async function compileSvelte(
  svelteRequest: SvelteRequest,
  code: string,
  options: Partial<ResolvedOptions>
): Promise<CompileData> {
  const { filename, normalizedFilename, cssId, ssr } = svelteRequest
  const { onwarn, emitCss = true } = options
  const dependencies = []
  const finalCompilerOptions: CompileOptions = {
    ...options.compilerOptions,
    filename,
    generate: ssr ? 'ssr' : 'dom',
    css: !emitCss,
    hydratable: true
  }

  let preprocessed
  if (options.preprocess) {
    preprocessed = await preprocess(code, options.preprocess, { filename })
    if (preprocessed.dependencies)
      dependencies.push(...preprocessed.dependencies)
    if (preprocessed.map) finalCompilerOptions.sourcemap = preprocessed.map
  }

  const compiled = compile(
    preprocessed ? preprocessed.code : code,
    finalCompilerOptions
  )

  ;(compiled.warnings || []).forEach((warning) => {
    if (!emitCss && warning.code === 'css-unused-selector') return
    // TODO handle warnings
    if (onwarn) onwarn(warning /*, this.warn*/)
    //else this.warn(warning)
  })

  if (emitCss && compiled.css.code) {
    // TODO properly update sourcemap?
    compiled.js.code += `\nimport ${JSON.stringify(svelteRequest.cssId)};\n`

    if (!ssr && options.hot) {
      // for hmr with emitCss we need to use a stable hash, patch compiler output
      useStableCssClass(compiled.js, compiled.css, svelteRequest.cssId)
    }
  }

  // only apply hmr when not in ssr context and hot options are set
  if (!ssr && makeHot) {
    compiled.js.code = makeHot({
      id: filename,
      compiledCode: compiled.js.code,
      hotOptions: options.hot,
      compiled,
      originalCode: code,
      compileOptions: finalCompilerOptions
    })
  }

  compiled.js.dependencies = dependencies

  // return everything that was created during preprocess/compile
  const result = {
    filename,
    normalizedFilename,
    cssId,
    code,
    preprocessed,
    compiled,
    compilerOptions: finalCompilerOptions,
    options,
    ssr
  }

  cacheCompileData(result)

  return result
}

export function createCompileSvelte({ hot = false, hotApi = '', adapter = '' }) {
  const makeHot = hot && createMakeHot({ walk, hotApi, adapter })
  return _createCompileSvelte(makeHot)
}

function useStableCssClass(js: Code, css: Code, cssId: string) {
  // TODO is there a better way to get this?
  const current = css.code.match(/\.svelte-[^\{]*/)![0].substring(1)
  const stable = `s-${safeBase64Hash(cssId, 12)}`
  if (current.length !== stable.length) {
    // TODO do something about it. should we update sourcemaps or find a way to tell the compiler we want a specific hash
    // see https://github.com/sveltejs/svelte/pull/4377
    log.warn(
      `replaced css hash ${current} with different length ${stable} for ${cssId}`
    )
  }
  const currentValueRE = new RegExp(current, 'g')
  // TODO use safer replace regex or other means. (ast?)
  js.code = js.code.replace(currentValueRE, stable)
  css.code = css.code.replace(currentValueRE, stable)
}

const _cache = new Map<string, CompileData>()
const _ssrCache = new Map<string, CompileData>()

function getCache(ssr: boolean): Map<string, CompileData> {
  return ssr ? _ssrCache : _cache
}

export function getCompileData(
  svelteRequest: SvelteRequest,
  errorOnMissing = true
): CompileData | undefined {
  const cache = getCache(svelteRequest.ssr)
  const id = svelteRequest.normalizedFilename
  if (cache.has(id)) {
    return cache.get(id)!
  }
  if (errorOnMissing) {
    throw new Error(
      `${id} has no corresponding entry in the ${
        svelteRequest.ssr ? 'ssr' : ''
      }cache. ` +
        `This is a @svitejs/vite-plugin-svelte internal error, please open an issue.`
    )
  }
}

function cacheCompileData(compileData: CompileData) {
  const cache = getCache(!!compileData.ssr)
  const id = compileData.normalizedFilename
  cache.set(id, compileData)
}

export interface Code {
  code: string
  map?: any
  dependencies?: any[]
}
export interface Compiled {
  js: Code
  css: Code
  ast: any // TODO type
  warnings: any[] // TODO type
  vars: {
    name: string
    export_name: string
    injected: boolean
    module: boolean
    mutated: boolean
    reassigned: boolean
    referenced: boolean
    writable: boolean
    referenced_from_script: boolean
  }[]
  stats: {
    timings: {
      total: number
    }
  }
}

export interface CompileData {
  filename: string
  normalizedFilename: string
  cssId: string
  code: string
  preprocessed?: Processed
  compiled: Compiled
  compilerOptions: CompileOptions
  options: Partial<ResolvedOptions>
  ssr: boolean | undefined
}
