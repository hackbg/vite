import path from 'path'
import { pathToFileURL } from 'url'
import { ViteDevServer } from '../server'
import {
  dynamicImport,
  isBuiltin,
  unwrapId,
  usingDynamicImport
} from '../utils'
import { rebindErrorStacktrace, ssrRewriteStacktrace } from './ssrStacktrace'
import {
  ssrExportAllKey,
  ssrModuleExportsKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrDynamicImportKey
} from './ssrTransform'
import { transformRequest } from '../server/transformRequest'
import { InternalResolveOptions, tryNodeResolve } from '../plugins/resolve'
import { hookNodeResolve } from '../plugins/ssrRequireHook'

interface SSRContext {
  global: typeof globalThis
}

type SSRModule = Record<string, any>

const pendingModules = new Map<string, Promise<SSRModule>>()
const pendingImports = new Map<string, string[]>()

export async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: string[] = []
): Promise<SSRModule> {
  url = unwrapId(url)

  // when we instantiate multiple dependency modules in parallel, they may
  // point to shared modules. We need to avoid duplicate instantiation attempts
  // by register every module as pending synchronously so that all subsequent
  // request to that module are simply waiting on the same promise.
  const pending = pendingModules.get(url)
  if (pending) {
    return pending
  }

  const modulePromise = instantiateModule(url, server, context, urlStack)
  pendingModules.set(url, modulePromise)
  modulePromise
    .catch(() => {
      pendingImports.delete(url)
    })
    .finally(() => {
      pendingModules.delete(url)
    })
  return modulePromise
}

async function instantiateModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: string[] = []
): Promise<SSRModule> {
  const { moduleGraph } = server
  const mod = await moduleGraph.ensureEntryFromUrl(url)

  if (mod.ssrModule) {
    return mod.ssrModule
  }

  const result =
    mod.ssrTransformResult ||
    (await transformRequest(url, server, { ssr: true }))
  if (!result) {
    // TODO more info? is this even necessary?
    throw new Error(`failed to load module for ssr: ${url}`)
  }

  const ssrModule = {
    [Symbol.toStringTag]: 'Module'
  }
  Object.defineProperty(ssrModule, '__esModule', { value: true })

  // Tolerate circular imports by ensuring the module can be
  // referenced before it's been instantiated.
  mod.ssrModule = ssrModule

  const ssrImportMeta = {
    // The filesystem URL, matching native Node.js modules
    url: pathToFileURL(mod.file!).toString()
  }

  urlStack = urlStack.concat(url)
  const isCircular = (url: string) => urlStack.includes(url)

  const {
    isProduction,
    resolve: { dedupe, preserveSymlinks },
    root
  } = server.config

  // The `extensions` and `mainFields` options are used to ensure that
  // CommonJS modules are preferred. We want to avoid ESM->ESM imports
  // whenever possible, because `hookNodeResolve` can't intercept them.
  const resolveOptions: InternalResolveOptions = {
    dedupe,
    extensions: ['.js', '.cjs', '.json'],
    isBuild: true,
    isProduction,
    isRequire: true,
    mainFields: ['main'],
    preserveSymlinks,
    root
  }

  // Since dynamic imports can happen in parallel, we need to
  // account for multiple pending deps and duplicate imports.
  const pendingDeps: string[] = []

  const ssrImport = async (dep: string) => {
    if (dep[0] !== '.' && dep[0] !== '/') {
      return nodeImport(dep, mod.file!, resolveOptions)
    }
    dep = unwrapId(dep)
    if (!isCircular(dep) && !pendingImports.get(dep)?.some(isCircular)) {
      pendingDeps.push(dep)
      if (pendingDeps.length === 1) {
        pendingImports.set(url, pendingDeps)
      }
      const mod = await ssrLoadModule(dep, server, context, urlStack)
      if (pendingDeps.length === 1) {
        pendingImports.delete(url)
      } else {
        pendingDeps.splice(pendingDeps.indexOf(dep), 1)
      }
      // return local module to avoid race condition #5470
      return mod
    }
    return moduleGraph.urlToModuleMap.get(dep)?.ssrModule
  }

  const ssrDynamicImport = (dep: string) => {
    // #3087 dynamic import vars is ignored at rewrite import path,
    // so here need process relative path
    if (dep[0] === '.') {
      dep = path.posix.resolve(path.dirname(url), dep)
    }
    return ssrImport(dep)
  }

  function ssrExportAll(sourceModule: any) {
    for (const key in sourceModule) {
      if (key !== 'default') {
        Object.defineProperty(ssrModule, key, {
          enumerable: true,
          configurable: true,
          get() {
            return sourceModule[key]
          }
        })
      }
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const AsyncFunction = async function () {}.constructor as typeof Function
    const initModule = new AsyncFunction(
      `global`,
      ssrModuleExportsKey,
      ssrImportMetaKey,
      ssrImportKey,
      ssrDynamicImportKey,
      ssrExportAllKey,
      result.code + `\n//# sourceURL=${mod.url}`
    )
    await initModule(
      context.global,
      ssrModule,
      ssrImportMeta,
      ssrImport,
      ssrDynamicImport,
      ssrExportAll
    )
  } catch (e) {
    const stacktrace = ssrRewriteStacktrace(e.stack, moduleGraph)
    rebindErrorStacktrace(e, stacktrace)
    server.config.logger.error(
      `Error when evaluating SSR module ${url}:\n${stacktrace}`,
      {
        timestamp: true,
        clear: server.config.clearScreen,
        error: e
      }
    )
    throw e
  }

  return Object.freeze(ssrModule)
}

// In node@12+ we can use dynamic import to load CJS and ESM
async function nodeImport(
  id: string,
  importer: string,
  resolveOptions: InternalResolveOptions
) {
  // Node's module resolution is hi-jacked so Vite can ensure the
  // configured `resolve.dedupe` and `mode` options are respected.
  const viteResolve = (
    id: string,
    importer: string,
    options = resolveOptions
  ) => {
    const resolved = tryNodeResolve(id, importer, options, false)
    if (!resolved) {
      const err: any = new Error(
        `Cannot find module '${id}' imported from '${importer}'`
      )
      err.code = 'ERR_MODULE_NOT_FOUND'
      throw err
    }
    return resolved.id
  }

  // When an ESM module imports an ESM dependency, this hook is *not* used.
  const unhookNodeResolve = hookNodeResolve(
    (nodeResolve) => (id, parent, isMain, options) => {
      // Fix #5709, use require to resolve files with the '.node' file extension.
      // See detail, https://nodejs.org/api/addons.html#addons_loading_addons_using_require
      if (id[0] === '.' || isBuiltin(id) || id.endsWith('.node')) {
        return nodeResolve(id, parent, isMain, options)
      }
      if (parent) {
        return viteResolve(id, parent.id)
      }
      // Importing a CJS module from an ESM module. In this case, the import
      // specifier is already an absolute path, so this is a no-op.
      // Options like `resolve.dedupe` and `mode` are not respected.
      return id
    }
  )

  let url: string
  if (id.startsWith('node:') || isBuiltin(id)) {
    url = id
  } else {
    url = viteResolve(
      id,
      importer,
      // Non-external modules can import ESM-only modules, but only outside
      // of test runs, because we use Node `require` in Jest to avoid segfault.
      typeof jest === 'undefined'
        ? { ...resolveOptions, tryEsmOnly: true }
        : resolveOptions
    )
    if (usingDynamicImport) {
      url = pathToFileURL(url).toString()
    }
  }

  try {
    const mod = await dynamicImport(url)
    return proxyESM(mod)
  } finally {
    unhookNodeResolve()
  }
}

// rollup-style default import interop for cjs
function proxyESM(mod: any) {
  const defaultExport = getDefaultExport(mod)
  return new Proxy(mod, {
    get(mod, prop) {
      if (prop === 'default') return defaultExport
      return mod[prop] ?? defaultExport?.[prop]
    }
  })
}

function getDefaultExport(moduleExports: any) {
  // `moduleExports` is one of the following:
  //   - `const moduleExports = require(file)`
  //   - `const moduleExports = await import(file)`
  let defaultExport =
    'default' in moduleExports ? moduleExports.default : moduleExports

  // Node.js doesn't support `__esModule`, see https://github.com/nodejs/node/issues/40891
  // This means we need to unwrap the `__esModule` wrapper ourselves.
  //
  // For example:
  // ```ts
  // export default 'hi'
  // ```
  //
  // Which TypeScript transpiles to:
  // ```js
  // use strict";
  // exports.__esModule = true;
  // exports["default"] = 'hi';
  // ```
  //
  // This means that `moduleExports.default` denotes `{ __esModule, default: 'hi }` thus the actual
  // default lives in `moduleExports.default.default`.
  if (defaultExport && '__esModule' in defaultExport) {
    defaultExport = defaultExport.default
  }

  return defaultExport
}
