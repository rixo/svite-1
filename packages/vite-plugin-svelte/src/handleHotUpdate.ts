import { ModuleNode, HmrContext } from 'vite'
import { CompileData } from './utils/compile'
import { log } from './utils/log'
import { SvelteRequest } from './utils/id'
import { VitePluginSvelteCache } from './utils/VitePluginSvelteCache'

/**
 * Vite-specific HMR handling
 */
export async function handleHotUpdate(
  compileSvelte: Function,
  ctx: HmrContext,
  svelteRequest: SvelteRequest,
  cache: VitePluginSvelteCache
): Promise<ModuleNode[] | void> {
  const { read, server } = ctx
  const { cssHash } = svelteRequest
  const cachedCompileData = cache.getCompileData(svelteRequest, false)
  if (!cachedCompileData) {
    // file hasn't been requested yet (e.g. async component)
    log.debug(`handleHotUpdate first call ${svelteRequest.id}`)
    return
  }

  const content = await read()
  const compileData: CompileData = await compileSvelte(
    svelteRequest,
    content,
    cachedCompileData.options
  )
  cache.setCompileData(compileData)

  const affectedModules = new Set<ModuleNode | undefined>()

  const cssModule = server.moduleGraph.getModuleById(svelteRequest.cssId)
  const mainModule = server.moduleGraph.getModuleById(svelteRequest.id)
  if (cssModule && cssChanged(cachedCompileData, compileData)) {
    log.debug('handleHotUpdate css changed')
    affectedModules.add(cssModule)
  }

  if (mainModule && jsChanged(cssHash, cachedCompileData, compileData)) {
    log.debug('handleHotUpdate js changed')
    affectedModules.add(mainModule)
  }

  const result = [...affectedModules].filter(Boolean) as ModuleNode[]
  log.debug(`handleHotUpdate result for ${svelteRequest.id}`, result)

  // TODO is this enough? see also: https://github.com/vitejs/vite/issues/2274
  const ssrModulesToInvalidate = result.filter((m) => !!m.ssrTransformResult)
  if (ssrModulesToInvalidate.length > 0) {
    log.debug(
      `invalidating modules ${ssrModulesToInvalidate
        .map((m) => m.id)
        .join(', ')}`
    )
    ssrModulesToInvalidate.forEach((moduleNode) =>
      server.moduleGraph.invalidateModule(moduleNode)
    )
  }

  return result
}

function normalizeNonCss(code: string, cssHash: string) {
  // trim HMR transform
  const indexHmrTransform = code.indexOf(
    'import * as ___SVELTE_HMR_HOT_API from'
  )
  if (indexHmrTransform !== -1) code = code.slice(0, indexHmrTransform)
  // remove irrelevant bits
  // NOTE the closer we're making our regexes to what we know of the compiler's
  //      output, the more fragile we are, but the less we risk catching
  //      similarly looking user's code
  return (
    code
      // ignore css hashes in the code (that have changed, necessarily)
      .replace(new RegExp('\\s*\\b' + cssHash + '\\b\\s*', 'g'), '')
      // TODO this one might need to be a little more specific
      .replace(/\s*attr_dev\([^,]+,\s*"class",\s*""\);?\s*/g, '')
      // Svelte now adds locations in dev mode, code locations can change when
      // CSS change, but we're unaffected (not real behaviour changes)
      .replace(/\s*\badd_location\s*\([^)]*\)\s*;?/g, '')
  )
}

function cssChanged(prev: CompileData, next: CompileData) {
  return !isCodeEqual(prev.compiled.css?.code, next.compiled.css?.code)
}

function jsChanged(hash: string, prev: CompileData, next: CompileData) {
  return !isCodeEqual(
    normalizeNonCss(prev.compiled.js?.code, hash),
    normalizeNonCss(next.compiled.js?.code, hash)
  )
}

function isCodeEqual(prev: string, next: string): boolean {
  if (!prev && !next) return false
  if ((!prev && next) || (prev && !next)) return true
  return prev === next
}
