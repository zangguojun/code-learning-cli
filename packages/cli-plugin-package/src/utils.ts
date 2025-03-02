import { join } from 'path';
import * as globby from 'globby';
import { unlink, existsSync, stat, readFileSync, copy } from 'fs-extra';
import { findNpmModule } from '@midwayjs/command-core';
import * as semver from 'semver';
interface Ilayer {
  [extName: string]: {
    path: string;
  };
}

export function formatLayers(...multiLayers: Ilayer[]) {
  const layerTypeList = { npm: {}, oss: {} };
  multiLayers.forEach((layer: Ilayer) => {
    Object.keys(layer || {}).forEach(layerName => {
      if (!layer[layerName] || !layer[layerName].path) {
        return;
      }
      const [type, path] = layer[layerName].path.split(':');
      if (!layerTypeList[type]) {
        return;
      }
      layerTypeList[type][layerName] = path;
    });
  });
  return layerTypeList;
}

function commonPrefixUtil(str1: string, str2: string): string {
  let result = '';
  const n1 = str1.length;
  const n2 = str2.length;

  for (let i = 0, j = 0; i <= n1 - 1 && j <= n2 - 1; i++, j++) {
    if (str1[i] !== str2[j]) {
      break;
    }
    result += str1[i];
  }
  return result;
}

export function commonPrefix(arr: string[]): string {
  let prefix: string = (arr && arr[0]) || '';
  const n = (arr && arr.length) || 0;
  for (let i = 1; i <= n - 1; i++) {
    prefix = commonPrefixUtil(prefix, arr[i]);
  }
  if (!prefix || prefix === '/') {
    return '';
  }
  const result = prefix.replace(/\/[^/]*$/gi, '') || '/';
  if (result && !/^\//.test(result)) {
    return '/' + result;
  }
  if (result === '/') {
    return '';
  }
  return result;
}

export const uselessFilesMatch = [
  '**/*.md',
  '**/*.markdown',
  '**/LICENSE',
  '**/license',
  '**/LICENSE.txt',
  '**/MIT-LICENSE.txt',
  '**/LICENSE-MIT.txt',
  '**/*.d.ts',
  '**/*.ts.map',
  '**/*.js.map',
  '**/*.test.js',
  '**/*.test.ts',
  '**/travis.yml',
  '**/.travis.yml',
  '**/src/**/*.ts',
  '**/test/',
  '**/tests/',
  '**/coverage/',
  '**/.github/',
  '**/.coveralls.yml',
  '**/.npmignore',
  '**/AUTHORS',
  '**/HISTORY',
  '**/Makefile',
  '**/.jshintrc',
  '**/.eslintrc',
  '**/.eslintrc.json',
  '**/@types/',
  '**/.mwcc-cache/',
];

export const removeUselessFiles = async (target: string) => {
  const nm = join(target, 'node_modules');
  const list = await globby(uselessFilesMatch, {
    cwd: nm,
    deep: 10,
  });
  console.log('  - Useless files Count', list.length);
  let size = 0;
  for (const file of list) {
    const path = join(nm, file);
    if (existsSync(path)) {
      const stats = await stat(path);
      size += stats.size;
      await unlink(path);
    }
  }
  console.log(
    `  - Remove Useless file ${Number(size / (2 << 19)).toFixed(2)} MB`
  );
};

// 分析装饰器上面的函数信息
export const analysisDecorator = async (cwd: string, spec?) => {
  const midwayCoreMod = findNpmModule(cwd, '@midwayjs/core');
  const pkg = join(midwayCoreMod, 'package.json');
  const corePkgJson = JSON.parse(readFileSync(pkg, 'utf-8'));
  const {
    ServerlessTriggerCollector,
    MidwayFrameworkService,
    MidwayServerlessFunctionService,
    prepareGlobalApplicationContext,
    WebRouterCollector,
  } = require(midwayCoreMod);
  let result;
  let collector;
  if (ServerlessTriggerCollector) {
    collector = new ServerlessTriggerCollector(cwd);
    result = await collector.getFunctionList();
  } else {
    if (
      corePkgJson?.version?.[0] === '3' &&
      prepareGlobalApplicationContext &&
      spec?.provider?.starter
    ) {
      const midwayDecoratorMod = findNpmModule(cwd, '@midwayjs/decorator');
      const {
        CONFIGURATION_KEY,
        listModule,
        Types,
      } = require(midwayDecoratorMod);
      const applicationContext = prepareGlobalApplicationContext({
        baseDir: cwd,
        appDir: cwd,
      });
      await applicationContext.getAsync(MidwayFrameworkService, [
        applicationContext,
      ]);
      const cycles = listModule(CONFIGURATION_KEY);
      for (const cycle of cycles) {
        if (cycle.target && Types.isClass(cycle.target)) {
          await applicationContext.getAsync(cycle.target);
        }
      }
      const midwayServerlessFunctionService = applicationContext.get(
        MidwayServerlessFunctionService
      );
      result = await midwayServerlessFunctionService.getFunctionList();
    } else {
      collector = new WebRouterCollector(cwd, {
        includeFunctionRouter: true,
      });
      result = await collector.getFlattenRouterTable();
    }
  }
  const allFunc = spec?.functions || {};
  if (Array.isArray(result)) {
    result.forEach(func => {
      if (!func.functionTriggerName) {
        return;
      }
      const handler = func.funcHandlerName;
      if (!handler || func.functionName?.includes('undefined')) {
        return;
      }
      if (func.handlerName?.includes('undefined')) {
        // midwayjs/core v2 版本 处理 @Func 直接挂在到 class 上面的情况存在缺陷
        // 没有把通过 @Func 装饰器传入的 funHandler 赋值到 handlerName 上
        // ref: https://github.com/midwayjs/midway/blob/2.x/packages/core/src/util/webRouterCollector.ts#L364
        // funHandler: xxx.abc
        // handler: xxx.abc
        // func.handlerName: className.undefined
        if (corePkgJson?.version?.[0] === '2') {
          func.handlerName = handler;
        } else {
          return;
        }
      }

      if (!func.functionTriggerMetadata) {
        func.functionTriggerMetadata = {};
      }

      const funcName =
        func.functionMetadata?.functionName ||
        func.functionTriggerMetadata?.functionName ||
        func.functionName ||
        handler.replace(/[^\w]/g, '-');
      if (!allFunc[funcName]) {
        allFunc[funcName] = {
          handler,
          events: [],
        };
      }

      Object.assign(allFunc[funcName], func.functionMetadata);

      delete allFunc[funcName].functionName;

      if (!allFunc[funcName].events) {
        allFunc[funcName].events = [];
      }

      if (!allFunc[funcName].handler) {
        allFunc[funcName].handler = handler;
      }

      delete func.functionTriggerMetadata.functionName;
      delete func.functionTriggerMetadata.middware;

      const trigger = func.functionTriggerName;
      let isAddToTrigger = false;
      if (trigger === 'http') {
        const { path, method } = func.functionTriggerMetadata;
        let methodList = [].concat(method || []);
        if (methodList.includes('any') || methodList.includes('all')) {
          func.functionTriggerMetadata.method = 'any';
          methodList = ['any'];
        } else {
          func.functionTriggerMetadata.method = methodList;
        }
        // 避免重复路径创建多个trigger
        const httpTrigger = allFunc[funcName].events.find(event => {
          return !!event.http && event.http.path === path;
        });
        if (httpTrigger) {
          if (
            httpTrigger.http.method === 'any' ||
            func.functionTriggerMetadata.method === 'any'
          ) {
            httpTrigger.http.method = 'any';
          } else {
            httpTrigger.http.method = [].concat(httpTrigger.http.method || []);
            if (method) {
              [].concat(method).forEach(methodItem => {
                if (!httpTrigger.http.method.includes(methodItem)) {
                  httpTrigger.http.method.push(methodItem);
                }
              });
            }
          }
          isAddToTrigger = true;
        }
      }

      if (!isAddToTrigger) {
        const triggerIsBoolean = !Object.keys(func.functionTriggerMetadata)
          .length;
        allFunc[funcName].events.push({
          [trigger]: triggerIsBoolean ? true : func.functionTriggerMetadata,
        });
      }
    });
  }

  let applicationContext;
  if (typeof collector?.getApplicationContext === 'function') {
    applicationContext = collector?.getApplicationContext();
  }

  return {
    funcSpec: allFunc,
    applicationContext,
  };
};

interface ModInfo {
  name: string;
  version: string;
}
export const findModuleFromNodeModules = async (
  moduleInfoList: ModInfo[],
  baseNodeModuleDir: string,
  fromNodeModulesPath: string,
  moduleMap: { [modName: string]: { version: string; path: string } } = {}
) => {
  for (const moduleInfo of moduleInfoList) {
    const { name, version } = moduleInfo;
    if (moduleMap[name] && semver.satisfies(moduleMap[name].version, version)) {
      continue;
    }

    const modulePath = join(fromNodeModulesPath, moduleInfo.name);
    let info = {
      path: modulePath,
    };
    let pkgJson: any = {};
    if (existsSync(modulePath)) {
      pkgJson = JSON.parse(
        readFileSync(join(info.path, 'package.json')).toString()
      );
    } else {
      info = getModuleCycleFind(
        moduleInfo.name,
        baseNodeModuleDir,
        fromNodeModulesPath
      );
      if (!info) {
        return;
      }
      pkgJson = JSON.parse(
        readFileSync(join(info.path, 'package.json')).toString()
      );
      if (!semver.satisfies(pkgJson.version, moduleInfo.version)) {
        return;
      }
    }
    moduleMap[moduleInfo.name] = {
      version: pkgJson.version,
      path: info.path,
    };
    const pkgDepsModuleInfoList: ModInfo[] = [];
    if (pkgJson.dependencies) {
      Object.keys(pkgJson.dependencies).map(modName => {
        const version = pkgJson.dependencies[modName];
        pkgDepsModuleInfoList.push({
          name: modName,
          version,
        });
      });
    }

    const childInfo = await findModuleFromNodeModules(
      pkgDepsModuleInfoList,
      baseNodeModuleDir,
      join(info.path, 'node_modules'),
      moduleMap
    );
    if (!childInfo) {
      return;
    }
  }
  return moduleMap;
};

const getModuleCycleFind = (
  moduleName,
  baseNodeModuleDir,
  fromNodeModuleDir
) => {
  while (true) {
    const modulePath = join(fromNodeModuleDir, moduleName);
    if (existsSync(modulePath)) {
      return {
        name: moduleName,
        path: modulePath,
      };
    }
    if (baseNodeModuleDir === fromNodeModuleDir) {
      return;
    }
    const parentDir = join(fromNodeModuleDir, '../');
    if (parentDir === fromNodeModuleDir) {
      return;
    }
    fromNodeModuleDir = parentDir;
  }
};

export const copyFromNodeModules = async (
  moduleInfoList: ModInfo[],
  fromNodeModulesPath: string,
  targetNodeModulesPath: string
) => {
  const moduleMap = await findModuleFromNodeModules(
    moduleInfoList,
    fromNodeModulesPath,
    fromNodeModulesPath
  );
  if (!moduleMap) {
    return;
  }
  const moduleNames = Object.keys(moduleMap);
  const result = await Promise.all(
    moduleNames.map(async name => {
      const { path } = moduleMap[name];
      const target = join(targetNodeModulesPath, name);
      await copy(path, target, {
        dereference: true,
        filter: src => {
          if (src.endsWith('/node_modules')) {
            return false;
          }
          return true;
        },
      });
      return name;
    })
  );
  return result;
};
