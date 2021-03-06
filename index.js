'use strict';

const precinct = require('precinct');
const path = require('path');
const fs = require('fs');
const cabinet = require('filing-cabinet');
const debug = require('debug')('tree');
const Config = require('./lib/Config');

/**
 * Recursively find all dependencies (avoiding circular) traversing the entire dependency tree
 * and returns a flat list of all unique, visited nodes
 *
 * @param {Object} options
 * @param {String} options.filename - The path of the module whose tree to traverse
 * @param {String} options.directory - The directory containing all JS files
 * @param {String} [options.requireConfig] - The path to a requirejs config
 * @param {String} [options.webpackConfig] - The path to a webpack config
 * @param {String} [options.nodeModulesConfig] - config for resolving entry file for node_modules
 * @param {Object} [options.visited] - Cache of visited, absolutely pathed files that should not be reprocessed.
 *                             Format is a filename -> tree as list lookup table
 * @param {Array} [options.nonExistent] - List of partials that do not exist
 * @param {Boolean} [options.isListForm=false]
 * @param {Boolean} [options.isPackageForm=false]
 * @param {String|Object} [options.tsConfig] Path to a typescript config (or a preloaded one).
 * @return {Object}
 */
module.exports = function (options) {
  const config = new Config(options);

  if (!fs.existsSync(config.filename)) {
    debug('file ' + config.filename + ' does not exist');
    return config.isListForm || config.isPackageForm ? [] : {};
  }

  config.pkgId = getPakcageId(config);

  const results = traverse(config);
  debug('traversal complete', results);

  dedupeNonExistent(config.nonExistent);
  debug('deduped list of nonExistent partials: ', config.nonExistent);

  let tree;
  if (config.isListForm) {
    debug('list form of results requested');

    tree = Array.from(results);
  } else if (config.isPackageForm) {
    debug('package form of results requested');

    tree = Array.from(results).filter((item) => {
      return item != '';
    });
  } else {
    debug('object form of results requested');

    tree = {};
    tree[config.filename] = results;
  }

  debug('final tree', tree);
  return tree;
};

/**
 * Executes a post-order depth first search on the dependency tree and returns a
 * list of absolute file paths. The order of files in the list will be the
 * proper concatenation order for bundling.
 *
 * In other words, for any file in the list, all of that file's dependencies (direct or indirect) will appear at
 * lower indices in the list. The root (entry point) file will therefore appear last.
 *
 * The list will not contain duplicates.
 *
 * Params are those of module.exports
 */
module.exports.toList = function (options) {
  options.isListForm = true;

  return module.exports(options);
};

module.exports.toPackage = function (options) {
  options.isPackageForm = true;

  return module.exports(options);
}

/**
 * Returns the list of dependencies for the given filename
 *
 * Protected for testing
 *
 * @param  {Config} config
 * @return {Array}
 */
module.exports._getDependencies = function (config) {
  let dependencies;
  const precinctOptions = config.detectiveConfig;
  precinctOptions.includeCore = false;

  try {
    dependencies = precinct.paperwork(config.filename, precinctOptions);

    debug('extracted ' + dependencies.length + ' dependencies: ', dependencies);

  } catch (e) {
    debug('error getting dependencies: ' + e.message);
    debug(e.stack);
    return [];
  }

  const resolvedDependencies = [];

  for (let i = 0, l = dependencies.length; i < l; i++) {
    const dep = dependencies[i];

    const result = cabinet({
      partial: dep,
      filename: config.filename,
      directory: config.directory,
      ast: precinct.ast,
      config: config.requireConfig,
      webpackConfig: config.webpackConfig,
      nodeModulesConfig: config.nodeModulesConfig,
      tsConfig: config.tsConfig
    });

    if (!result) {
      debug('skipping an empty filepath resolution for partial: ' + dep);
      config.nonExistent.push(dep);
      continue;
    }

    const exists = fs.existsSync(result);

    if (!exists) {
      config.nonExistent.push(dep);
      debug('skipping non-empty but non-existent resolution: ' + result + ' for partial: ' + dep);
      continue;
    }

    resolvedDependencies.push(result);
  }

  return resolvedDependencies;
};

/**
 * @param  {Config} config
 * @return {Object|Set}
 */
function traverse(config) {
  let subTree = config.isListForm || config.isPackageForm ? new Set() : {};

  debug('\ntraversing ' + config.filename);

  if (config.visited[config.filename]) {
    debug('already visited ' + config.filename);
    return config.visited[config.filename];
  }

  let dependencies = module.exports._getDependencies(config);

  debug('cabinet-resolved all dependencies: ', dependencies);
  // Prevents cycles by eagerly marking the current file as read
  // so that any dependent dependencies exit
  config.visited[config.filename] = config.isListForm || config.isPackageForm ? [] : {};

  if (config.filter) {
    debug('using filter function to filter out dependencies');
    debug('unfiltered number of dependencies: ' + dependencies.length);
    dependencies = dependencies.filter(function (filePath) {
      return config.filter(filePath, config.filename);
    });
    debug('filtered number of dependencies: ' + dependencies.length);
  }

  for (let i = 0, l = dependencies.length; i < l; i++) {
    const d = dependencies[i];
    const localConfig = config.clone();
    localConfig.filename = d;
    localConfig.pkgId = getPakcageId(localConfig);

    if (localConfig.isListForm) {
      for (let item of traverse(localConfig)) {
        subTree.add(item);
      }
    } else if (localConfig.isPackageForm) {
      for (let item of traverse(localConfig)) {
        subTree.add(item);
      }
    } else {
      subTree[d] = traverse(localConfig);
    }
  }

  if (config.isListForm) {
    subTree.add(config.filename);
    config.visited[config.filename].push(...subTree);
  } else if (config.isPackageForm) {
    subTree.add(config.pkgId);
    config.visited[config.filename].push(...subTree);
  } else {
    config.visited[config.filename] = subTree;
  }

  return subTree;
}

// Mutate the list input to do a dereferenced modification of the user-supplied list
function dedupeNonExistent(nonExistent) {
  const deduped = new Set(nonExistent);
  nonExistent.length = deduped.size;

  let i = 0;
  for (const elem of deduped) {
    nonExistent[i] = elem;
    i++;
  }
}

/**
 * Get the name of the package whose files are used
 *
 * @param {Config} config
 * @return {String} absolute path to the package
 */
function getPakcageId(config) {
  const directoryList = config.filename.split(path.sep);
  if (directoryList.includes('node_modules')) {
    while (directoryList.length > 0 && directoryList[directoryList.length - 1] !== 'node_modules') {
      const pkgPath = directoryList.join(path.sep).concat(path.sep, 'package.json');
      if (fs.existsSync(pkgPath)) {
        return directoryList.join(path.sep);
      }
      directoryList.pop();
    }
  }
  debug('package.json does not exist');
  return '';
}
